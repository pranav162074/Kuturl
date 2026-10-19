import { z } from 'zod';
import env from '../config/env.js';
import { validateLongUrl } from './urlSafety.js';

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

// strictObject rejects fields it doesn't know, so a typo like "expires_at" is an error
// instead of being silently ignored and creating a link that never expires
export const createLinkSchema = z.strictObject({
  url: longUrlSchema,
  expiresAt: expiresAtSchema.optional(),
});

export const createApiKeySchema = z.strictObject({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(100, 'name must be at most 100 characters'),
});