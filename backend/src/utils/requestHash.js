import { createHash } from 'node:crypto';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const sortKeys = (_key, value) =>
  isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

export const canonicalJson = (value) => JSON.stringify(value ?? null, sortKeys);

export const hashRequest = (method, path, body) =>
  createHash('sha256').update(`${method} ${path}\n${canonicalJson(body)}`).digest('hex');

export const requestHash = (req) => hashRequest(req.method, `${req.baseUrl}${req.path}`, req.body);
