# Changes.md — Caching Fix Documentation

## Overview

This document details the bugs identified in the original caching implementation of the Student Side-Hustle Platform backend, the improvements made, and the reasoning behind each fix.

---

## Issues Identified in the Original Caching Implementation

### Bug 1 — Cache Not Invalidated After DELETE or POST
**Location:** `DELETE /tasks/:id`, `POST /tasks`

The cache was never cleared after a task was deleted or created. This meant:
- A deleted task would still appear in `GET /tasks` because the cached list was stale.
- A newly created task would be invisible to any client that had already fetched the list.

---

### Bug 2 — Shared / Non-Namespaced Global Cache Key
**Location:** `GET /tasks`

The cache key was hardcoded as `'global_data_key'` — a single flat string used for all data. This is dangerous because:
- Any other data stored under the same map could collide or overwrite task data.
- It is impossible to selectively invalidate related entries (e.g., invalidate only task list, not individual task detail).

---

### Bug 3 — Promise Stored in Cache Instead of Resolved Data
**Location:** `GET /tasks`

```js
// BEFORE (broken)
const tasksPromise = prisma.task.findMany();  // returns a Promise
cache.set(cacheKey, tasksPromise);            // stores unresolved Promise!
```

When a subsequent request hit the cache, it retrieved the **Promise object** (not an array), causing `res.json()` to serialize `{}` instead of task data. This is a critical async misuse.

---

### Bug 4 — Null Values Cached Permanently (Memory Leak + Wrong Responses)
**Location:** `GET /tasks/:id`

If a task with a given ID did not exist in the database, `prisma.task.findUnique()` returned `null`. The code cached this `null` value with no TTL. Subsequent requests for that same ID would immediately receive `null` — even after the task was created — because the cache never expired.

---

### Bug 5 — Missing TTL (Time-To-Live) on All Cache Entries
**Location:** All cached routes

No expiry mechanism existed. Every entry accumulated in the `Map` indefinitely, causing:
- **Memory leak** — the cache grew without bound under sustained traffic.
- **Permanently stale data** — once cached, data was never refreshed even when the database changed.

---

### Bug 6 — Incorrect HTTP Status Codes
**Location:** All routes

| Route | Old Code | Correct Code |
|-------|----------|--------------|
| `POST /tasks` | 200 OK | **201 Created** |
| `GET /tasks/:id` when not found | 200 with `null` body | **404 Not Found** |
| All error paths | No response sent | **500 Internal Server Error** |

---

### Bug 7 — Errors Silently Swallowed (No Response Sent)
**Location:** All `catch` blocks

Every `catch` block only logged the error with `console.log()` and did **not** send a response. This left HTTP connections hanging indefinitely, eventually timing out the client.

---

## Improvements Implemented

### Fix 1 — Dedicated Cache Service (`src/services/cacheService.js`)

A dedicated module was extracted to encapsulate all caching logic. This enforces separation of concerns and makes the cache easy to test or swap in the future.

**Features of the cache service:**
- `get(key)` — returns `undefined` if key is absent or expired (lazy TTL check).
- `set(key, value, ttlMs)` — stores data with a configurable TTL (default 60 s). **Silently rejects `null` and `undefined`.**
- `del(key)` — removes a specific key.
- `invalidateTasks(id?)` — removes `tasks:list` and optionally `task:<id>`.
- `flush()` — clears entire cache (useful for testing).
- `KEYS` factory object — single source of truth for key naming.

---

### Fix 2 — Namespaced Cache Keys

| Scope | Old Key | New Key |
|-------|---------|---------|
| All tasks | `'global_data_key'` | `'tasks:list'` |
| Single task | `'task_42'` | `'task:42'` |

Using namespaced keys prevents collisions and allows targeted invalidation.

---

### Fix 3 — Resolved Data Stored (Not Promises)

```js
// AFTER (correct)
const tasks = await prisma.task.findMany();  // awaited first
cache.set(cacheKey, tasks);                  // stores plain array
```

The `await` ensures only a fully resolved value enters the cache.

---

### Fix 4 — Null Prevention in Cache

```js
// In cacheService.set()
if (value === null || value === undefined) {
  console.warn(`[Cache] Skipped caching null/undefined for key "${key}"`);
  return;
}
```

And at the route level:
```js
if (!task) {
  return res.status(404).json({ error: `Task with id ${id} not found.` });
}
// Only reaches here if task is a real object — safe to cache.
cache.set(cacheKey, task);
```

---

### Fix 5 — TTL on All Cache Entries

All entries now expire after **60 seconds** by default. This means:
- Memory is bounded — entries are lazily evicted when accessed after expiry.
- Stale data self-heals — even without an explicit invalidation event, data refreshes within one minute.

The TTL constant lives in `cacheService.js` and can be changed in one place.

---

### Fix 6 — Cache Invalidation on Mutation

```js
// POST /tasks — new task created
cache.invalidateTasks();          // clears tasks:list

// DELETE /tasks/:id — task removed
cache.invalidateTasks(id);        // clears tasks:list AND task:<id>
```

This guarantees that after any write operation, the next read will query the database and reflect the true state.

---

### Fix 7 — Correct HTTP Status Codes

| Route | Status |
|-------|--------|
| `POST /tasks` success | **201 Created** |
| `GET /tasks/:id` not found | **404 Not Found** |
| Invalid/missing body fields | **400 Bad Request** |
| Unexpected server errors | **500 Internal Server Error** |

---

### Fix 8 — Proper Error Responses in All Catch Blocks

Every `catch` block now:
1. Logs the full error with `console.error()`.
2. Returns a JSON response with an appropriate status code so clients are never left hanging.

---

## Reasoning Behind the Changes

| Principle | Application |
|-----------|-------------|
| **Correctness before optimization** | Cache invalidation and null-guards were added first; TTL is a secondary safety net. |
| **Minimal complexity** | No external cache library (Redis, Memcached) was introduced; the existing `Map` is extended with TTL logic. |
| **Separation of concerns** | Cache logic lives entirely in `cacheService.js`, keeping route handlers clean. |
| **Compatibility** | The API surface (routes, request/response shape) is unchanged. |
| **Memory efficiency** | TTL + lazy eviction ensures the cache cannot grow without bound. |

---

## File Changes Summary

| File | Action | Reason |
|------|--------|--------|
| `src/index.js` | **Modified** | Fixed all caching bugs, status codes, error handling |
| `src/services/cacheService.js` | **Created** | Extracted cache logic into a reusable service layer |
| `Changes.md` | **Created** | This document |
