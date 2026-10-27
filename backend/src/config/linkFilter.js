import env from './env.js';
import { channel } from './redisConnection.js';

export default {
  enabled: env.bloomFilterEnabled,
  falsePositiveRate: 0.01,
  minCapacity: 100_000,
  growth: 2,
  batchSize: 10_000,
  refreshIntervalMs: 10 * 60 * 1000,
  rebuildIntervalMs: 6 * 60 * 60 * 1000,
  overlapMs: 2 * 60 * 1000,
  channel: channel('links:created'),
  publishTimeoutMs: 200,
};
