import Redis from 'ioredis';
import env from './env.js';
import logger from './logger.js';

const REMINDER_MS = 60_000;

export const channel = (name) => `${env.redisKeyPrefix}${name}`;

export const logConnectionHealth = (connection, name, { log = logger, now = Date.now } = {}) => {
  let downSince = null;
  let lastReminder = 0;
  let connectedOnce = false;

  connection.on('error', (error) => {
    const at = now();
    if (downSince === null) {
      downSince = at;
      lastReminder = at;
      log.error({ err: error }, `${name} unavailable`);
    } else if (at - lastReminder >= REMINDER_MS) {
      lastReminder = at;
      log.warn({ code: error.code, downForSeconds: Math.round((at - downSince) / 1000) }, `${name} still unavailable`);
    }
  });

  connection.on('ready', () => {
    if (downSince !== null) {
      log.info({ downForSeconds: Math.round((now() - downSince) / 1000) }, `${name} reconnected`);
    } else if (!connectedOnce) {
      log.info(`${name} connected`);
    }
    connectedOnce = true;
    downSince = null;
  });
};

export const createRedisConnection = (name = 'Redis', options = {}) => {
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    keyPrefix: env.redisKeyPrefix || undefined,
    ...options,
  });
  logConnectionHealth(connection, name);
  return connection;
};
