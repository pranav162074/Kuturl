import env from './config/env.js';
import logger from './config/logger.js';
import { closePool } from './config/db.js';
import { createRedisConnection } from './config/redisConnection.js';
import { createClickWorker } from './worker/clickWorker.js';
import { createMetricsServer } from './worker/metricsServer.js';

const connection = createRedisConnection('Worker Redis');
const worker = createClickWorker({ redis: connection });
const metricsServer = env.workerMetricsPort ? createMetricsServer() : null;

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutting down');

  const force = setTimeout(() => {
    logger.error('Worker shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    if (metricsServer) await new Promise((resolve) => metricsServer.close(resolve));
    await worker.stop();
    await connection.quit();
    await closePool();
  } catch (error) {
    logger.error({ err: error }, 'Error while stopping the worker');
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

try {
  await worker.start();
  if (metricsServer) {
    metricsServer.listen(env.workerMetricsPort, () => {
      logger.info({ port: env.workerMetricsPort }, 'Worker metrics listening');
    });
  }
} catch (error) {
  logger.fatal({ err: error }, 'Click worker could not start');
  process.exit(1);
}
