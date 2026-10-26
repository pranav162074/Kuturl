import redis from '../config/redis.js';
import logger from '../config/logger.js';
import { withTimeout } from '../utils/timeout.js';
import { cacheErrors } from '../config/metrics.js';

const PREFIX = 'link:';
const COMMAND_TIMEOUT_MS = 100; // past this, Postgres is the faster answer
const BREAKER_MS = 5000; // how long to skip Redis after it fails

export const TTL_SECONDS = {
  active: 3600,
  missing: 30, // short, so a code that is created later becomes reachable quickly
  unavailable: 60, // disabled and expired links
};

const keyFor = (code) => `${PREFIX}${code}`;

// A tiny circuit breaker. After one failure the cache is skipped for a few seconds, so a Redis
// outage costs one slow request instead of making every redirect wait for its own timeout.
let skipCacheUntil = 0;

export const resetBreaker = () => {
  skipCacheUntil = 0;
};

// Runs a Redis command and never throws: a cache problem must not break a request.
// It returns null when the cache is skipped or fails.
// force: used when a link changes. Skipping that write would leave a stale entry behind, so it
// ignores the breaker and always tries.
const guarded = async (command, { force = false } = {}) => {
  if (!force && Date.now() < skipCacheUntil) return null;
  try {
    return await withTimeout(command(), COMMAND_TIMEOUT_MS);
  } catch (error) {
    skipCacheUntil = Date.now() + BREAKER_MS;
    cacheErrors.inc();
    if (force) {
      logger.error({ err: error }, 'Could not update the cache, an old entry may live until its TTL');
    } else {
      logger.warn({ err: error }, 'Cache unavailable, reading from Postgres for a few seconds');
    }
    return null;
  }
};

// The three things a code can be. "e" is the expiry as epoch milliseconds, or null.
export const entryFromLink = (link) => {
  if (!link) return { s: 'missing' };
  if (link.disabledAt) return { s: 'disabled' };
  if (link.limitReachedAt) return { s: 'exhausted' };
  const entry = { s: 'active', u: link.longUrl, e: link.expiresAt ? new Date(link.expiresAt).getTime() : null };
  if (link.passwordHash) entry.p = true;
  if (link.maxClicks) {
    entry.m = link.maxClicks;
    entry.i = String(link.id);
  }
  return entry;
};

// How long an entry may stay cached
export const ttlFor = (entry, now = Date.now()) => {
  if (entry.s === 'missing') return TTL_SECONDS.missing;
  if (entry.s === 'disabled' || entry.s === 'exhausted') return TTL_SECONDS.unavailable;
  if (entry.e === null) return TTL_SECONDS.active;

  const remaining = Math.ceil((entry.e - now) / 1000);
  if (remaining <= 0) return TTL_SECONDS.unavailable; // already expired: keep a short tombstone
  return Math.min(TTL_SECONDS.active, remaining); // never outlive the link itself
};

export const JITTER_RATIO = 0.1;

export const jitter = (ttl, random = Math.random) => Math.max(1, ttl - Math.floor(ttl * JITTER_RATIO * random()));

const STATES = new Set(['active', 'missing', 'disabled', 'exhausted']);

// Anything that does not look like an entry we wrote is treated as a miss
const parse = (raw) => {
  try {
    const entry = JSON.parse(raw);
    if (!entry || !STATES.has(entry.s)) return null;
    if (entry.s === 'active' && typeof entry.u !== 'string') return null;
    if ('p' in entry && entry.p !== true) return null;
    if ('m' in entry && (!Number.isInteger(entry.m) || entry.m < 1 || typeof entry.i !== 'string')) return null;
    return entry;
  } catch {
    return null;
  }
};

export const getEntry = async (code) => {
  const raw = await guarded(() => redis.get(keyFor(code)));
  if (!raw) return null;

  const entry = parse(raw);
  if (!entry) {
    // Not something we wrote. Remove it, so the fill that follows (which never overwrites) can replace it
    await guarded(() => redis.del(keyFor(code)));
  }
  return entry;
};

// Used after a cache miss. NX means "only if the key does not exist": if the owner changed
// the link while we were reading Postgres, their newer entry must win over our older copy.
export const fillEntry = (code, entry, now = Date.now()) =>
  guarded(() => redis.set(keyFor(code), JSON.stringify(entry), 'EX', jitter(ttlFor(entry, now)), 'NX'));

// Used when a link changes: overwrites whatever is cached with the new state
export const setEntry = (code, entry, now = Date.now()) =>
  guarded(() => redis.set(keyFor(code), JSON.stringify(entry), 'EX', jitter(ttlFor(entry, now))), { force: true });

export const deleteEntry = (code) => guarded(() => redis.del(keyFor(code)), { force: true });