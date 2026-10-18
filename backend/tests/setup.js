// Safety guard: tests create and delete data, so they may only run against a local or CI
// database, never against Neon or a hosted Redis. It checks the actual hostname.
const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres', 'redis']);

const isSafeUrl = (url) => {
  try {
    return SAFE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[key]) {
    throw new Error(`${key} is not set. Tests run in CI, which provides Postgres and Redis.`);
  }
  if (!isSafeUrl(process.env[key])) {
    throw new Error(`Refusing to run tests: ${key} does not point at a local or CI service.`);
  }
}