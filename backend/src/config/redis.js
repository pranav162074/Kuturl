import Redis from 'ioredis';
import env from './env.js';
import logger from './logger.js';

// The redirect path will treat Redis as an optimisation, not a requirement, so commands
// must fail quickly when Redis is unreachable instead of hanging the request.
const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 2,
  connectTimeout: 10_000,
});

redis.on('connect', () => logger.info('Redis connected'));

// Without an error listener, a dropped connection would throw an unhandled error
redis.on('error', (error) => {
  logger.error({ err: error }, 'Redis error');
});

export default redis;