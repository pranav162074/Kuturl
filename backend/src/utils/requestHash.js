import { createHash, createHmac } from 'node:crypto';
import env from '../config/env.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const sortKeys = (key, value) => {
  if (key === 'password' && typeof value === 'string') {
    return `hmac:${createHmac('sha256', env.codeSecret).update(value).digest('hex')}`;
  }
  return isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;
};

export const canonicalJson = (value) => JSON.stringify(value ?? null, sortKeys);

export const hashRequest = (method, path, body) =>
  createHash('sha256').update(`${method} ${path}\n${canonicalJson(body)}`).digest('hex');

export const requestHash = (req) => hashRequest(req.method, `${req.baseUrl}${req.path}`, req.body);
