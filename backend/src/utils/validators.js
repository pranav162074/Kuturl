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