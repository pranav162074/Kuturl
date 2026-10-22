import { readFileSync } from 'node:fs';
import redis from '../config/redis.js';
import logger from '../config/logger.js';
import { withTimeout } from '../utils/timeout.js';

redis.defineCommand('tokenBucket', {
  numberOfKeys: 1,
  lua: readFileSync(new URL('../lua/tokenBucket.lua', import.meta.url), 'utf8'),
});

const COMMAND_TIMEOUT_MS = 500;
const BREAKER_MS = 5000;

let unavailableUntil = 0;

export const resetRateLimiterBreaker = () => {
  unavailableUntil = 0;
};

export const consume = async (policyName, identity, policy, cost = 1) => {
  const { capacity, refillPerSecond } = policy;
  if (!(capacity >= 1) || !(refillPerSecond > 0)) throw new RangeError('invalid rate limit policy');
  if (!(cost >= 1) || cost > capacity) throw new RangeError('cost must be between 1 and the capacity');

  if (Date.now() < unavailableUntil) return null;

  try {
    const [allowed, remaining, retryMs, untilFullMs] = await withTimeout(
      redis.tokenBucket(`rl:${policyName}:${identity}`, capacity, refillPerSecond, cost),
      COMMAND_TIMEOUT_MS
    );

    return {
      allowed: allowed === 1,
      limit: capacity,
      remaining,
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
      resetSeconds: Math.ceil(untilFullMs / 1000),
    };
  } catch (error) {
    unavailableUntil = Date.now() + BREAKER_MS;
    logger.warn({ err: error, policy: policyName }, 'Rate limiter unavailable');
    return null;
  }
};