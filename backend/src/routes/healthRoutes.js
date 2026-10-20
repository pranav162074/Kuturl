import express from 'express';
import { query } from '../config/db.js';
import redis from '../config/redis.js';
import { withTimeout } from '../utils/timeout.js';

const router = express.Router();

const probe = async (check) => {
  try {
    await withTimeout(check(), 3000);
    return 'ok';
  } catch {
    return 'down';
  }
};

// Liveness: is the process up? Touches nothing, so uptime monitors can call it all day
// without waking the database or spending Redis commands.
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// Readiness: can the app serve traffic? Postgres is required, because redirects fall back
// to it. Redis is an optimisation, so losing it reports "degraded" and not "down".
router.get('/health', async (req, res) => {
  const [postgres, cache] = await Promise.all([
    probe(() => query('SELECT 1')),
    probe(() => redis.ping()),
  ]);

  const status = postgres === 'down' ? 'down' : cache === 'down' ? 'degraded' : 'ok';
  res.status(status === 'down' ? 503 : 200).json({ status, postgres, redis: cache });
});

export default router;