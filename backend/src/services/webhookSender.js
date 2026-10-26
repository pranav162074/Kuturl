import { createHmac, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import settings from '../config/webhooks.js';
import { isPublicAddress } from '../utils/urlSafety.js';

export const USER_AGENT = 'Kuturl-Webhooks/1.0';

export const signPayload = (secret, body, timestamp) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export const verifySignature = (secret, body, header, { now = Date.now(), toleranceSeconds = settings.signatureToleranceSeconds } = {}) => {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = signPayload(secret, body, timestamp).split('v1=')[1];
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
};

const allowed = (address) => settings.allowPrivateTargets || isPublicAddress(address);

const blocked = () => Object.assign(new Error('Webhook target resolves to a private or reserved address'), { code: 'EBLOCKED' });

const safeLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const usable = addresses.filter((entry) => allowed(entry.address));
    if (usable.length === 0) return callback(blocked());
    if (options.all) return callback(null, usable);
    return callback(null, usable[0].address, usable[0].family);
  });
};

export const deliver = ({ url, secret, body, eventId, eventType, now = Date.now() }) =>
  new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: null, error: 'Invalid URL' });
      return;
    }

    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) && !allowed(hostname)) {
      resolve({ ok: false, status: null, error: blocked().message });
      return;
    }

    const timestamp = Math.floor(now / 1000);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'POST',
      lookup: safeLookup,
      timeout: settings.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENT,
        'Kuturl-Event-Id': eventId,
        'Kuturl-Event-Type': eventType,
        'Kuturl-Signature': signPayload(secret, body, timestamp),
      },
    });

    request.on('response', (response) => {
      response.resume();
      response.on('end', () => {
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        resolve({ ok, status: response.statusCode, error: ok ? null : `Endpoint answered ${response.statusCode}` });
      });
      response.on('error', () => resolve({ ok: false, status: response.statusCode, error: 'Response failed' }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error(`No response within ${settings.timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({ ok: false, status: null, error: error.message }));
    request.end(body);
  });
