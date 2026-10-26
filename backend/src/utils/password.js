import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const PASSWORD_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 32, saltLength: 16 };

const derive = (password, salt, { N, r, p, keyLength }) =>
  scryptAsync(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: 256 * N * r });

export const hashPassword = async (password, params = PASSWORD_PARAMS) => {
  const salt = randomBytes(params.saltLength);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
};

const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export const verifyPassword = async (password, stored) => {
  const match = FORMAT.exec(stored ?? '');
  if (!match || typeof password !== 'string') return false;

  const [, N, r, p, salt, key] = match;
  const expected = Buffer.from(key, 'base64url');
  const params = { N: Number(N), r: Number(r), p: Number(p), keyLength: expected.length };
  if (params.N > 1_048_576 || params.r > 32 || params.p > 16 || expected.length < 16) return false;

  const actual = await derive(password, Buffer.from(salt, 'base64url'), params);
  return timingSafeEqual(actual, expected);
};
