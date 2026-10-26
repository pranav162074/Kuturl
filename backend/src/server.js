import http from 'node:http';
import env from './config/env.js';
import logger from './config/logger.js';
import app from './app.js';
import { closePool } from './config/db.js';
import redis from './config/redis.js';
import { deleteExpiredIdempotencyKeys } from './db/idempotencyKeys.js';
import linkFilter from './services/linkFilter.js';

const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'Kuturl is listening');
  linkFilter.start().catch((error) => logger.error({ err: error }, 'Link filter could not start'));
});

const IDEMPOTENCY_CLEANUP_MS = 60 * 60 * 1000;

const cleanupIdempotencyKeys = async () => {
  try {
    const deleted = await deleteExpiredIdempotencyKeys();
    if (deleted > 0) logger.info({ deleted }, 'Removed expired idempotency keys');
  } catch (error) {
    logger.warn({ err: error }, 'Could not remove expired idempotency keys');
  }
};

const idempotencyCleanup = setInterval(cleanupIdempotencyKeys, IDEMPOTENCY_CLEANUP_MS);
idempotencyCleanup.unref();

// On a deploy or a stop signal: stop taking new connections, let in-flight requests finish,
// then close the database and Redis. A timer forces the exit if something refuses to finish.
let shuttingDown = false;

const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(idempotencyCleanup);

  const force = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(async () => {
    try {
      await linkFilter.stop();
      await closePool();
      await redis.quit();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing connections');
    }
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A promise nobody handled is a bug, so record it loudly. The process keeps running.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});