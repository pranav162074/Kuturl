import { timingSafeEqual, createHash } from 'node:crypto';
import client from 'prom-client';
import env from './env.js';
import pool from './db.js';
import analytics from './analytics.js';
import { withTimeout } from '../utils/timeout.js';

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time to answer HTTP requests, by route template',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const redirects = new client.Counter({
  name: 'kuturl_redirects_total',
  help: 'Short link lookups, by outcome and whether the cache answered',
  labelNames: ['outcome', 'cache'],
  registers: [registry],
});

export const coalescedLookups = new client.Counter({
  name: 'kuturl_redirect_coalesced_lookups_total',
  help: 'Cache misses that waited for a database lookup already in flight instead of starting their own',
  registers: [registry],
});

export const bloomFilterChecks = new client.Counter({
  name: 'kuturl_bloom_filter_checks_total',
  help: 'Redirect lookups checked against the Bloom filter: absent (answered 404 at once), maybe (passed on), or bypassed (filter not ready)',
  labelNames: ['result'],
  registers: [registry],
});

let linkFilterStats = () => null;

export const watchLinkFilter = (stats) => {
  linkFilterStats = stats;
};

const filterGauge = (name, help, field) =>
  new client.Gauge({
    name,
    help,
    registers: [registry],
    collect() {
      const stats = linkFilterStats();
      if (stats) this.set(stats[field]);
    },
  });

filterGauge('kuturl_bloom_filter_items', 'Codes added to the Bloom filter since it was last built', 'items');
filterGauge('kuturl_bloom_filter_capacity', 'Codes the Bloom filter was sized for', 'capacity');
filterGauge('kuturl_bloom_filter_bytes', 'Memory used by the Bloom filter bit array', 'bytes');
filterGauge(
  'kuturl_bloom_filter_estimated_false_positive_rate',
  'Expected share of absent codes the filter wrongly passes on, at its current fill',
  'estimatedFalsePositiveRate'
);

export const qrCodes = new client.Counter({
  name: 'kuturl_qr_codes_total',
  help: 'QR code requests, by format and whether they were rendered, served from memory, or answered 304',
  labelNames: ['format', 'result'],
  registers: [registry],
});

export const cacheErrors = new client.Counter({
  name: 'kuturl_cache_errors_total',
  help: 'Redis cache commands that failed or timed out',
  registers: [registry],
});

export const rateLimitDecisions = new client.Counter({
  name: 'kuturl_rate_limit_decisions_total',
  help: 'Rate limiter decisions, by policy',
  labelNames: ['policy', 'outcome'],
  registers: [registry],
});

export const idempotencyRequests = new client.Counter({
  name: 'kuturl_idempotency_requests_total',
  help: 'Requests that carried an Idempotency-Key, by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

export const clickEvents = new client.Counter({
  name: 'kuturl_click_events_total',
  help: 'Click events sent to the stream, or dropped because Redis was unavailable',
  labelNames: ['outcome'],
  registers: [registry],
});

export const workerBatches = new client.Counter({
  name: 'kuturl_click_worker_batches_total',
  help: 'Click worker batches, by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});

export const workerEvents = new client.Counter({
  name: 'kuturl_click_worker_events_total',
  help: 'Click events handled by the worker: recorded, ignored (duplicate or deleted link) or skipped (malformed)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const workerBatchDuration = new client.Histogram({
  name: 'kuturl_click_worker_batch_duration_seconds',
  help: 'Time to store and acknowledge one batch of clicks',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

new client.Gauge({
  name: 'kuturl_db_pool_connections',
  help: 'Postgres pool connections, by state',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

const STREAM_TIMEOUT_MS = 500;
let streamRedis = null;
let snapshot = null;

const toObject = (list) => {
  const object = {};
  for (let i = 0; i + 1 < list.length; i += 2) object[list[i]] = list[i + 1];
  return object;
};

const readStream = async () => {
  if (!streamRedis || streamRedis.status !== 'ready') return null;
  try {
    const [length, oldest, groups] = await withTimeout(
      Promise.all([
        streamRedis.xlen(analytics.streamKey),
        streamRedis.xrange(analytics.streamKey, '-', '+', 'COUNT', 1),
        streamRedis.xinfo('GROUPS', analytics.streamKey).catch(() => []),
      ]),
      STREAM_TIMEOUT_MS
    );
    const group = groups.map(toObject).find((fields) => fields.name === analytics.group);
    const oldestMs = oldest.length > 0 ? Number(oldest[0][0].split('-')[0]) : null;
    return {
      length,
      pending: group ? Number(group.pending) : 0,
      oldestAgeSeconds: oldestMs === null ? 0 : Math.max(0, (Date.now() - oldestMs) / 1000),
    };
  } catch {
    return null;
  }
};

const streamSnapshot = () => {
  if (!snapshot) {
    snapshot = readStream().finally(() => {
      setTimeout(() => {
        snapshot = null;
      }, 1000).unref();
    });
  }
  return snapshot;
};

const streamGauge = (name, help, field) =>
  new client.Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      const values = await streamSnapshot();
      if (values) this.set(values[field]);
    },
  });

streamGauge('kuturl_click_stream_length', 'Click events waiting in the stream', 'length');
streamGauge('kuturl_click_stream_pending', 'Click events read by a worker but not yet acknowledged', 'pending');
streamGauge(
  'kuturl_click_stream_oldest_age_seconds',
  'Age of the oldest unprocessed click event, which is how far behind the worker is',
  'oldestAgeSeconds'
);

export const watchClickStream = (redis) => {
  streamRedis = redis;
  snapshot = null;
};

const digest = (value) => createHash('sha256').update(value).digest();

export const metricsAccess = (authorization) => {
  const token = env.metricsToken;
  if (!token) return env.isProduction ? 'disabled' : 'allowed';

  const match = /^Bearer (\S+)$/i.exec(authorization ?? '');
  if (!match) return 'denied';
  return timingSafeEqual(digest(match[1]), digest(token)) ? 'allowed' : 'denied';
};

export const metricsResponse = async (authorization) => {
  const access = metricsAccess(authorization);
  if (access === 'disabled') {
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'not_found', message: 'Route not found' }),
    };
  }
  if (access === 'denied') {
    return {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
      body: JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid metrics token' }),
    };
  }
  return {
    status: 200,
    headers: { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' },
    body: await registry.metrics(),
  };
};
