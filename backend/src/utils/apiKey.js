import { createHash, randomBytes } from 'node:crypto';

const KEY_PATTERN = /^kt_[A-Za-z0-9_-]{32}$/;

// 24 random bytes is 192 bits, far too many to guess. The "kt_" prefix makes a leaked key
// easy to recognise (secret scanners look for prefixes like this).
export const generateApiKey = () => `kt_${randomBytes(24).toString('base64url')}`;

// Keys are random, not human-chosen, so a plain SHA-256 is enough. A slow hash like bcrypt
// protects weak passwords, and it also can't be used here, because it is salted: the same
// key would hash differently each time, so we could not look it up by its hash.
export const hashApiKey = (key) => createHash('sha256').update(key).digest('hex');

// The first characters are stored so a key can be recognised in lists and logs
export const keyPrefix = (key) => key.slice(0, 8);

// A cheap shape check that rejects garbage before it reaches the database
export const looksLikeApiKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);