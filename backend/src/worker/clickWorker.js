import os from 'node:os';
import analytics from '../config/analytics.js';
import logger from '../config/logger.js';
import { recordClicks, ensureClickPartition, dropOldClickPartitions } from '../db/clicks.js';
import { DEVICES } from '../utils/device.js';
import { isValidCodeShape } from '../utils/codeFormat.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 31 * DAY_MS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toFields = (list) => {
  if (!Array.isArray(list)) return null;
  const fields = {};
  for (let i = 0; i + 1 < list.length; i += 2) fields[list[i]] = list[i + 1];
  return fields;
};

export const parseEntry = ([, list], now = Date.now()) => {
  const fields = toFields(list);
  if (!fields) return null;

  const ts = Number(fields.ts);
  const oldest = now - analytics.retentionMonths * MONTH_MS;
  if (!UUID.test(fields.id ?? '')) return null;
  if (!isValidCodeShape(fields.code)) return null;
  if (!Number.isInteger(ts) || ts < oldest || ts > now + DAY_MS) return null;
  if (!DEVICES.includes(fields.dev)) return null;
  if (typeof fields.ref !== 'string' || fields.ref.length > 253) return null;

  return {
    id: fields.id,
    code: fields.code,
    clickedAt: new Date(ts),
    referrerHost: fields.ref === '' ? null : fields.ref,
    device: fields.dev,
  };
};

export const createClickWorker = ({ redis, consumer = `${os.hostname()}-${process.pid}` }) => {
  let running = false;
  let loop = null;
  let maintenance = null;

  const ensureGroup = async () => {
    try {
      await redis.xgroup('CREATE', analytics.streamKey, analytics.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!String(error.message).includes('BUSYGROUP')) throw error;
    }
  };

  const handle = async (entries) => {
    if (entries.length === 0) return { read: 0, recorded: 0, skipped: 0 };

    const events = [];
    for (const entry of entries) {
      const event = parseEntry(entry);
      if (event) events.push(event);
    }

    const recorded = await recordClicks(events);
    const ids = entries.map(([id]) => id);
    await redis
      .multi()
      .xack(analytics.streamKey, analytics.group, ...ids)
      .xdel(analytics.streamKey, ...ids)
      .exec();

    return { read: entries.length, recorded, skipped: entries.length - events.length };
  };

  const claimAbandoned = async () => {
    const [, entries] = await redis.xautoclaim(
      analytics.streamKey,
      analytics.group,
      consumer,
      analytics.claimIdleMs,
      '0-0',
      'COUNT',
      analytics.batchSize
    );
    return (entries ?? []).filter((entry) => Array.isArray(entry) && entry[1] !== null);
  };

  const readNew = async (blockMs) => {
    const args = ['GROUP', analytics.group, consumer, 'COUNT', analytics.batchSize];
    if (blockMs > 0) args.push('BLOCK', blockMs);
    const result = await redis.xreadgroup(...args, 'STREAMS', analytics.streamKey, '>');
    return result ? result[0][1] : [];
  };

  const runOnce = async ({ blockMs = 0 } = {}) => {
    const abandoned = await claimAbandoned();
    if (abandoned.length > 0) return handle(abandoned);
    return handle(await readNew(blockMs));
  };

  const maintain = async () => {
    try {
      const now = new Date();
      await ensureClickPartition(now);
      await ensureClickPartition(new Date(now.getTime() + MONTH_MS));
      const dropped = await dropOldClickPartitions(analytics.retentionMonths, now);
      if (dropped.length > 0) logger.info({ dropped }, 'Dropped old click partitions');
    } catch (error) {
      logger.warn({ err: error }, 'Click partition maintenance failed');
    }
  };

  const run = async () => {
    let backoff = 0;
    while (running) {
      try {
        const result = await runOnce({ blockMs: analytics.blockMs });
        if (result.read > 0) logger.debug(result, 'Processed clicks');
        backoff = 0;
      } catch (error) {
        if (!running) break;
        backoff = Math.min(analytics.maxBackoffMs, backoff === 0 ? 500 : backoff * 2);
        logger.error({ err: error, retryInMs: backoff }, 'Click worker batch failed');
        await sleep(backoff);
      }
    }
  };

  const start = async () => {
    if (running) return;
    await ensureGroup();
    await maintain();
    running = true;
    maintenance = setInterval(maintain, analytics.maintenanceIntervalMs);
    maintenance.unref();
    loop = run();
    logger.info({ consumer, stream: analytics.streamKey }, 'Click worker started');
  };

  const stop = async () => {
    if (!running) return;
    running = false;
    clearInterval(maintenance);
    await loop;
    logger.info({ consumer }, 'Click worker stopped');
  };

  return { start, stop, runOnce, ensureGroup, consumer };
};
