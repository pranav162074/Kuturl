export default {
  streamKey: 'clicks',
  group: 'click-workers',
  maxLength: 20_000,
  batchSize: 200,
  blockMs: 2000,
  claimIdleMs: 30_000,
  maxBackoffMs: 30_000,
  retentionMonths: 6,
  maintenanceIntervalMs: 60 * 60 * 1000,
};
