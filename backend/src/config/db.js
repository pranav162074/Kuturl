import pg from 'pg';
import env from './env.js';
import logger from './logger.js';

// One shared pool for the whole app. The pool reuses connections instead of opening a new
// one per request, which is what keeps queries fast under load.
const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Neon's free database sleeps when idle, so the first connection can take a few seconds
  connectionTimeoutMillis: 10_000,
});

// An idle connection can drop (network blip, database restart). Without this handler,
// that error would crash the whole process.
pool.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected error on an idle Postgres client');
});

export const query = (text, params) => pool.query(text, params);

export const closePool = () => pool.end();

export default pool;