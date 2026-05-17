/**
 * cacheService.js
 *
 * A lightweight, reliable in-memory cache with:
 *  - Namespaced keys  (e.g. "tasks:list", "task:42")
 *  - Per-entry TTL    (entries expire automatically)
 *  - Null guard       (null / undefined results are never stored)
 *  - Explicit invalidation helpers for list & single-item entries
 */

const DEFAULT_TTL_MS = 60_000; // 60 seconds

/**
 * Internal store: Map<key, { value: any, expiresAt: number }>
 */
const store = new Map();

// ─── Key Factories ────────────────────────────────────────────────────────────

const KEYS = {
  taskList: () => 'tasks:list',
  task: (id) => `task:${id}`,
};

// ─── Core Helpers ─────────────────────────────────────────────────────────────

/**
 * Retrieve a cached value.
 * Returns undefined if the key does not exist or has expired.
 */
function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);  // Lazy expiry cleanup
    return undefined;
  }

  return entry.value;
}

/**
 * Store a value with a TTL.
 * Silently rejects null / undefined values to prevent caching invalid data.
 */
function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (value === null || value === undefined) {
    console.warn(`[Cache] Skipped caching null/undefined for key "${key}"`);
    return;
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Remove a specific key from the cache.
 */
function del(key) {
  store.delete(key);
}

/**
 * Invalidate everything that belongs to the task list,
 * plus optionally a single task entry by id.
 */
function invalidateTasks(id = null) {
  del(KEYS.taskList());
  if (id !== null) {
    del(KEYS.task(id));
  }
}

/**
 * Flush the entire cache (useful for testing / shutdown).
 */
function flush() {
  store.clear();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { get, set, del, invalidateTasks, flush, KEYS };
