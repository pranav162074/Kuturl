import { randomUUID } from 'node:crypto';
import redis from '../config/redis.js';
import logger from '../config/logger.js';
import analytics from '../config/analytics.js';
import { deviceClass } from '../utils/device.js';
import { referrerHost } from '../utils/referrer.js';
import { clickEvents } from '../config/metrics.js';

export const buildClickEvent = ({ code, userAgent, referer, now = Date.now() }) => ({
  id: randomUUID(),
  code,
  ts: String(now),
  ref: referrerHost(referer) ?? '',
  dev: deviceClass(userAgent),
});

export const recordClick = (input) => {
  if (redis.status !== 'ready') {
    clickEvents.inc({ outcome: 'dropped' });
    return false;
  }

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
    .then(() => clickEvents.inc({ outcome: 'queued' }))
    .catch((error) => {
      clickEvents.inc({ outcome: 'dropped' });
      logger.warn({ err: error }, 'Could not record a click');
    });
  return true;
};
