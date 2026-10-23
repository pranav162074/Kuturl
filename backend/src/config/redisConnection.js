import Redis from 'ioredis';
import env from './env.js';
import logger from './logger.js';

export const createRedisConnection = (name = 'Redis', options = {}) => {
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    ...options,
  });

  connection.on('connect', () => logger.info(`${name} connected`));
  connection.on('error', (error) => {
    logger.error({ err: error }, `${name} error`);
  });

  return connection;
};
