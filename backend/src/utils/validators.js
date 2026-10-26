import { z } from 'zod';
import env from '../config/env.js';
import { validateLongUrl } from './urlSafety.js';
import codes from '../services/codes.js';
import { isReservedAlias } from './reservedAliases.js';

const ownHost = new URL(env.baseUrl).hostname;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export const longUrlSchema = z.string({ error: 'URL is required' }).transform((value, ctx) => {
  const result = validateLongUrl(value, { ownHost });
  if (!result.ok) {
    ctx.issues.push({ code: 'custom', message: result.message, input: value });
    return z.NEVER;
  }
  return result.url;
});

const expiresAtSchema = z.iso
  .datetime({
    offset: true,
    error: 'expiresAt must be an ISO 8601 date-time, for example 2027-01-31T12:00:00Z',
  })
  .transform((value) => new Date(value))
  .refine((date) => date.getTime() > Date.now() + 60_000, {
    error: 'expiresAt must be at least a minute in the future',
  })
  .refine((date) => date.getTime() < Date.now() + TEN_YEARS_MS, {
    error: 'expiresAt must be within the next 10 years',
  });

// Checks run in this order, and the first failing one is the message the caller sees.
// Nothing is trimmed or changed: an alias is an identifier, so what you type is what you get.
export const aliasSchema = z
  .string({ error: 'alias must be text' })
  .min(3, 'alias must be at least 3 characters')
  .max(32, 'alias must be at most 32 characters')
  .regex(/^[A-Za-z0-9_-]*$/, 'alias may only contain letters, numbers, hyphens and underscores')
  .regex(/^[A-Za-z0-9].*[A-Za-z0-9]$/, 'alias must start and end with a letter or number')
  .refine((value) => !isReservedAlias(value), { error: 'That alias is reserved, please choose another' });

// strictObject rejects fields it doesn't know, so a typo like "expires_at" is an error
// instead of being silently ignored and creating a link that never expires
export const createLinkSchema = z.strictObject({
  url: longUrlSchema,
  alias: aliasSchema.optional(),
  expiresAt: expiresAtSchema.optional(),
});

export const createApiKeySchema = z.strictObject({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(100, 'name must be at most 100 characters'),
});

// Disable or re-enable a link, or change or remove its expiry (null removes it).
// The destination URL is deliberately not editable: swapping the target of a link people
// already trust is the classic phishing move, so a new destination means a new link.
export const updateLinkSchema = z
  .strictObject({
    disabled: z.boolean({ error: 'disabled must be true or false' }).optional(),
    expiresAt: expiresAtSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Provide disabled or expiresAt' });

// The cursor handed out by the list endpoint is the next link's id run through the same
// scrambler as short codes. Raw ids would reveal how many links exist across all owners.
export const listLinksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[0-9A-Za-z]{7}$/, 'cursor is not valid')
    .transform((value, ctx) => {
      try {
        return codes.decode(value).toString();
      } catch {
        ctx.issues.push({ code: 'custom', message: 'cursor is not valid', input: value });
        return z.NEVER;
      }
    })
    .optional(),
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STEP_MS = { hour: HOUR_MS, day: DAY_MS };
const MAX_BUCKETS = { hour: 744, day: 366 };
const DEFAULT_BUCKETS = { hour: 24, day: 30 };
const MAX_BREAKDOWN_DAYS = 186;
const DEFAULT_BREAKDOWN_DAYS = 30;

const statsDate = (name) =>
  z.iso
    .datetime({ offset: true, error: `${name} must be an ISO 8601 date-time, for example 2027-01-31T12:00:00Z` })
    .transform((value) => new Date(value));

const floorTo = (ms, step) => Math.floor(ms / step) * step;
const ceilTo = (ms, step) => Math.ceil(ms / step) * step;

const rejectRange = (ctx, message) => {
  ctx.issues.push({ code: 'custom', message, input: undefined });
  return z.NEVER;
};

export const statsSeriesQuerySchema = z
  .strictObject({
    interval: z.enum(['hour', 'day'], { error: 'interval must be hour or day' }).default('day'),
    from: statsDate('from').optional(),
    to: statsDate('to').optional(),
  })
  .transform(({ interval, from, to }, ctx) => {
    const step = STEP_MS[interval];
    const end = ceilTo((to ?? new Date()).getTime() + (to ? 0 : 1), step);
    const start = from ? floorTo(from.getTime(), step) : end - DEFAULT_BUCKETS[interval] * step;

    if (start >= end) return rejectRange(ctx, 'from must be before to');
    if ((end - start) / step > MAX_BUCKETS[interval]) {
      return rejectRange(ctx, `At most ${MAX_BUCKETS[interval]} ${interval}s can be requested at once`);
    }
    return { interval, from: new Date(start), to: new Date(end) };
  });

const breakdownRange = ({ from, to, ...rest }, ctx) => {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - DEFAULT_BREAKDOWN_DAYS * DAY_MS);

  if (start >= end) return rejectRange(ctx, 'from must be before to');
  if (end - start > MAX_BREAKDOWN_DAYS * DAY_MS) {
    return rejectRange(ctx, `The range can be at most ${MAX_BREAKDOWN_DAYS} days`);
  }
  return { ...rest, from: start, to: end };
};

export const statsDevicesQuerySchema = z
  .strictObject({ from: statsDate('from').optional(), to: statsDate('to').optional() })
  .transform(breakdownRange);

export const statsReferrersQuerySchema = z
  .strictObject({
    from: statsDate('from').optional(),
    to: statsDate('to').optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .transform(breakdownRange);

export const qrQuerySchema = z.strictObject({
  format: z.enum(['svg', 'png'], { error: 'format must be svg or png' }).default('svg'),
  size: z.coerce
    .number({ error: 'size must be a number' })
    .int('size must be a whole number')
    .min(128, 'size must be at least 128')
    .max(1024, 'size must be at most 1024')
    .default(512),
  margin: z.coerce
    .number({ error: 'margin must be a number' })
    .int('margin must be a whole number')
    .min(0, 'margin must be at least 0')
    .max(10, 'margin must be at most 10')
    .default(2),
  ecc: z.enum(['L', 'M', 'Q', 'H'], { error: 'ecc must be L, M, Q or H' }).default('M'),
});