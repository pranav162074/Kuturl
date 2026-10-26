import redis from '../config/redis.js';
import { createRedisConnection } from '../config/redisConnection.js';
import { query } from '../config/db.js';
import logger from '../config/logger.js';
import settings from '../config/linkFilter.js';
import { bloomFilterChecks, watchLinkFilter } from '../config/metrics.js';
import { createBloomFilter } from '../utils/bloomFilter.js';
import { isValidCodeShape } from '../utils/codeFormat.js';
import { withTimeout } from '../utils/timeout.js';

let filter = null;
let pendingDuringBuild = null;
let syncedAt = null;
let subscriber = null;
let timers = [];
let building = null;

const add = (code) => {
  filter?.add(code);
  pendingDuringBuild?.push(code);
};

const buildNow = async () => {
  pendingDuringBuild = [];
  try {
    const {
      rows: [snapshot],
    } = await query('SELECT count(*)::bigint AS total, now() AS now FROM links');
    const capacity = Math.max(settings.minCapacity, Math.ceil(Number(snapshot.total) * settings.growth));
    const next = createBloomFilter({ capacity, falsePositiveRate: settings.falsePositiveRate });

    let lastId = 0;
    for (;;) {
      const { rows } = await query('SELECT id, code FROM links WHERE id > $1 ORDER BY id LIMIT $2', [
        lastId,
        settings.batchSize,
      ]);
      for (const row of rows) next.add(row.code);
      if (rows.length < settings.batchSize) break;
      lastId = rows.at(-1).id;
    }
    for (const code of pendingDuringBuild) next.add(code);

    filter = next;
    syncedAt = snapshot.now;
    logger.info({ items: next.count, capacity, bytes: next.bytes }, 'Link filter built');
    return next;
  } finally {
    pendingDuringBuild = null;
  }
};

const rebuild = () => {
  if (!building) building = buildNow().finally(() => {
    building = null;
  });
  return building;
};

const refresh = async () => {
  if (!filter) return rebuild();
  if (building) return building;

  const since = new Date(syncedAt.getTime() - settings.overlapMs);
  const {
    rows: [result],
  } = await query(
    `SELECT now() AS now, coalesce(array_agg(code), '{}') AS codes FROM links WHERE created_at >= $1`,
    [since]
  );
  for (const code of result.codes) add(code);
  syncedAt = result.now;

  if (filter.count > filter.capacity) return rebuild();
  return filter;
};

const safely = (label, task) => async () => {
  try {
    await task();
  } catch (error) {
    logger.warn({ err: error }, `Link filter ${label} failed`);
  }
};

const mightExist = (code) => {
  if (!settings.enabled || !filter) {
    bloomFilterChecks.inc({ result: 'bypassed' });
    return true;
  }
  const maybe = filter.mightContain(code);
  bloomFilterChecks.inc({ result: maybe ? 'maybe' : 'absent' });
  return maybe;
};

const announce = async (...newCodes) => {
  if (newCodes.length === 0) return;
  for (const code of newCodes) add(code);
  if (!settings.enabled || redis.status !== 'ready') return;
  try {
    await withTimeout(redis.publish(settings.channel, newCodes.join(',')), settings.publishTimeoutMs);
  } catch (error) {
    logger.warn({ err: error }, 'Could not announce new links');
  }
};

const start = async ({ connection = createRedisConnection('Filter Redis') } = {}) => {
  if (!settings.enabled || subscriber) return;

  subscriber = connection;
  let subscribedOnce = false;
  subscriber.on('message', (channel, message) => {
    if (channel !== settings.channel) return;
    for (const code of message.split(',')) if (isValidCodeShape(code)) add(code);
  });
  subscriber.on('ready', () => {
    if (subscribedOnce) safely('refresh after reconnect', refresh)();
  });

  await subscriber.subscribe(settings.channel);
  subscribedOnce = true;
  await safely('build', rebuild)();

  timers = [
    setInterval(safely('refresh', refresh), settings.refreshIntervalMs),
    setInterval(safely('rebuild', rebuild), settings.rebuildIntervalMs),
  ];
  for (const timer of timers) timer.unref();
};

const stop = async () => {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  if (building) await building.catch(() => {});
  if (subscriber) {
    const connection = subscriber;
    subscriber = null;
    await connection.quit().catch(() => connection.disconnect());
  }
  filter = null;
  syncedAt = null;
};

const stats = () =>
  filter && {
    items: filter.count,
    capacity: filter.capacity,
    bytes: filter.bytes,
    estimatedFalsePositiveRate: filter.estimatedFalsePositiveRate(),
  };

watchLinkFilter(stats);

export default { start, stop, mightExist, announce, add, refresh, rebuild, stats, isReady: () => filter !== null };
