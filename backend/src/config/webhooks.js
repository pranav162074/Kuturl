import env from './env.js';
import { channel } from './redisConnection.js';

export default {
  events: ['link.click_limit_reached'],
  maxEndpointsPerKey: 5,
  timeoutMs: 5000,
  retryDelaysMs: [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000],
  batchSize: 20,
  leaseMs: 60_000,
  idleCheckMs: 10 * 60 * 1000,
  signatureToleranceSeconds: 300,
  nudgeChannel: channel('webhooks:nudge'),
  allowPrivateTargets: env.webhookAllowPrivateTargets,
};
