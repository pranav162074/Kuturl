import { randomUUID } from 'node:crypto';
import redis from '../config/redis.js';
import logger from '../config/logger.js';
import analytics from '../config/analytics.js';
import { deviceClass } from '../utils/device.js';
import { referrerHost } from '../utils/referrer.js';

export const buildClickEvent = ({ code, userAgent, referer, now = Date.now() }) => ({
  id: randomUUID(),
  code,
  ts: String(now),
  ref: referrerHost(referer) ?? '',
  dev: deviceClass(userAgent),
});

export const recordClick = (input) => {
  if (redis.status !== 'ready') return false;

  const event = buildClickEvent(input);
  redis
    .xadd(
      analytics.streamKey,
      'MAXLEN',
      '~',
      analytics.maxLength,
      '*',
      'id',
      event.id,
      'code',
      event.code,
      'ts',
      event.ts,
      'ref',
      event.ref,
      'dev',
      event.dev
    )
    .catch((error) => logger.warn({ err: error }, 'Could not record a click'));
  return true;
};
