import http from 'node:http';
import env from './config/env.js';
import logger from './config/logger.js';
import app from './app.js';
import { closePool } from './config/db.js';
import redis from './config/redis.js';

const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'Kuturl is listening');
});

// On a deploy or a stop signal: stop taking new connections, let in-flight requests finish,
// then close the database and Redis. A timer forces the exit if something refuses to finish.
let shuttingDown = false;

const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const force = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(async () => {
    try {
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