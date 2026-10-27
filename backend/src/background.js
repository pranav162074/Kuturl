import logger from './config/logger.js';
import { createRedisConnection } from './config/redisConnection.js';
import { createClickWorker } from './worker/clickWorker.js';
import { createWebhookDispatcher } from './worker/webhookDispatcher.js';

export const startBackgroundJobs = async () => {
  const connection = createRedisConnection('Worker Redis');
  const subscriber = createRedisConnection('Webhook Redis');
  const worker = createClickWorker({ redis: connection });
  const dispatcher = createWebhookDispatcher({ subscriber });

  await worker.start();
  await dispatcher.start();
  logger.info('Background jobs started');

  return {
    stop: async () => {
      await worker.stop();
      await dispatcher.stop();
      await connection.quit().catch(() => connection.disconnect());
    },
  };
};
