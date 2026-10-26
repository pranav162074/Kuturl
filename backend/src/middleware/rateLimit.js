import rateLimits from '../config/rateLimits.js';
import { consume } from '../services/rateLimiter.js';
import { clientKey } from '../utils/clientKey.js';
import { rateLimitDecisions } from '../config/metrics.js';

const SCOPES = new Set(['ip', 'key']);

const identityFor = (scope, req) => (scope === 'key' ? `k${req.apiKey.id}` : clientKey(req.ip));

const rateLimit = (policyName, { scope, cost = 1 }) => {
  if (!rateLimits.policies[policyName]) throw new Error(`Unknown rate limit policy: ${policyName}`);
  if (!SCOPES.has(scope)) throw new Error(`Unknown rate limit scope: ${scope}`);

  return async (req, res, next) => {
    if (!rateLimits.enabled) return next();

    const policy = rateLimits.policies[policyName];
    const amount = typeof cost === 'function' ? cost(req) : cost;
    const result = await consume(policyName, identityFor(scope, req), policy, amount);

    if (!result) {
      rateLimitDecisions.inc({ policy: policyName, outcome: 'unavailable' });
      if (policy.failOpen) return next();
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Temporarily unavailable, please try again shortly',
      });
    }

    res.set({
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining),
      'RateLimit-Reset': String(result.resetSeconds),
    });

    rateLimitDecisions.inc({ policy: policyName, outcome: result.allowed ? 'allowed' : 'limited' });
    if (result.allowed) return next();

    res.set('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many requests, please slow down',
      retryAfterSeconds: result.retryAfterSeconds,
    });
  };
};

export default rateLimit;