import env from './env.js';

export default {
  enabled: env.rateLimitEnabled,
  policies: {
    apiIp: { capacity: 120, refillPerSecond: 2, failOpen: true },
    keyCreation: { capacity: 5, refillPerSecond: 5 / 3600, failOpen: false },
    apiKey: { capacity: 100, refillPerSecond: 5, failOpen: true },
    linkCreation: { capacity: 100, refillPerSecond: 0.5, failOpen: true },
  },
};