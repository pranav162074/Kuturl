import { findLinkByCode } from '../db/links.js';
import { getEntry, fillEntry, entryFromLink } from './linkCache.js';
import { coalescedLookups } from '../config/metrics.js';

const inFlight = new Map();

export const inFlightLookups = () => inFlight.size;

const loadEntry = (code, now) => {
  const pending = inFlight.get(code);
  if (pending) {
    coalescedLookups.inc();
    return pending;
  }

  const lookup = (async () => {
    const entry = entryFromLink(await findLinkByCode(code));
    await fillEntry(code, entry, now);
    return entry;
  })().finally(() => inFlight.delete(code));

  inFlight.set(code, lookup);
  return lookup;
};

// Turns a cache entry into a decision. Expiry is compared with the clock on every call: a
// cache TTL only has one-second granularity and can lag, so it is never the source of truth.
const decide = (entry, now) => {
  if (entry.s === 'missing') return { status: 'not_found' };
  if (entry.s === 'disabled') return { status: 'gone', reason: 'disabled' };
  if (entry.e !== null && entry.e <= now) return { status: 'gone', reason: 'expired' };
  return { status: 'redirect', url: entry.u };
};

// Looks a code up in Redis first and falls back to Postgres. The cache helpers never throw,
// so a Redis problem only costs time. Postgres errors do propagate (a 500 is the honest answer).
export const resolveCode = async (code, now = Date.now()) => {
  let entry = await getEntry(code);
  let source = 'cache';

  if (!entry) {
    source = 'database';
    entry = await loadEntry(code, now);
  }

  return { ...decide(entry, now), source };
};