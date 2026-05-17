const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const cache = require('./services/cacheService');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// ─── GET /tasks ───────────────────────────────────────────────────────────────
// FIX 1: Use a namespaced key "tasks:list" instead of a global shared key.
// FIX 2: Await the DB query before caching — store resolved data, never a Promise.
// FIX 3: Errors now return a proper 500 response instead of being swallowed.

app.get('/tasks', async (req, res) => {
  try {
    const cacheKey = cache.KEYS.taskList();
    const cached = cache.get(cacheKey);

    if (cached !== undefined) {
      console.log('[Cache] HIT tasks:list');
      return res.status(200).json(cached);
    }

    console.log('[Cache] MISS tasks:list — querying DB');
    const tasks = await prisma.task.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // cacheService.set() silently skips null/undefined, so this is always safe.
    cache.set(cacheKey, tasks);

    return res.status(200).json(tasks);
  } catch (err) {
    console.error('[Error] GET /tasks', err);
    return res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────
// FIX 4: Namespaced key "task:<id>" per resource.
// FIX 5: Null values (task not found) are no longer cached — returns 404 instead.
// FIX 6: Proper 404 when task does not exist.

app.get('/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid task ID.' });
  }

  try {
    const cacheKey = cache.KEYS.task(id);
    const cached = cache.get(cacheKey);

    if (cached !== undefined) {
      console.log(`[Cache] HIT task:${id}`);
      return res.status(200).json(cached);
    }

    console.log(`[Cache] MISS task:${id} — querying DB`);
    const task = await prisma.task.findUnique({
      where: { id },
    });

    if (!task) {
      // FIX 5: Do NOT cache a null result — instead return 404 immediately.
      return res.status(404).json({ error: `Task with id ${id} not found.` });
    }

    cache.set(cacheKey, task);

    return res.status(200).json(task);
  } catch (err) {
    console.error(`[Error] GET /tasks/${id}`, err);
    return res.status(500).json({ error: 'Failed to fetch task.' });
  }
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────
// FIX 7: Correct status code 201 Created.
// FIX 8: Invalidate the task list cache so the next GET reflects the new task.

app.post('/tasks', async (req, res) => {
  const { title, description, price } = req.body;

  if (!title || !description || price === undefined) {
    return res.status(400).json({ error: 'title, description, and price are required.' });
  }

  const parsedPrice = parseFloat(price);
  if (isNaN(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: 'price must be a non-negative number.' });
  }

  try {
    const newTask = await prisma.task.create({
      data: { title, description, price: parsedPrice },
    });

    // FIX 8: Invalidate list so it is re-fetched fresh on next GET /tasks.
    cache.invalidateTasks();

    // FIX 7: 201 Created is semantically correct for resource creation.
    return res.status(201).json(newTask);
  } catch (err) {
    console.error('[Error] POST /tasks', err);
    return res.status(500).json({ error: 'Failed to create task.' });
  }
});

// ─── DELETE /tasks/:id ────────────────────────────────────────────────────────
// FIX 9: Invalidate BOTH "tasks:list" AND "task:<id>" after deletion.
// FIX 10: Return 404 if the task doesn't exist before attempting deletion.
// FIX 11: Return 200 with a confirmation message.

app.delete('/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid task ID.' });
  }

  try {
    // Verify task exists before deleting (avoids a Prisma P2025 crash).
    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: `Task with id ${id} not found.` });
    }

    await prisma.task.delete({ where: { id } });

    // FIX 9: Remove stale entries so deleted task never appears again.
    cache.invalidateTasks(id);

    return res.status(200).json({ message: `Task ${id} deleted successfully.` });
  } catch (err) {
    console.error(`[Error] DELETE /tasks/${id}`, err);
    return res.status(500).json({ error: 'Failed to delete task.' });
  }
});

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
