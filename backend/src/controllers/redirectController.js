import { isValidCodeShape } from '../utils/codeFormat.js';
import { resolveCode } from '../services/redirect.js';
import { recordClick } from '../services/clickEvents.js';
import { redirects, unlockAttempts } from '../config/metrics.js';
import rateLimits from '../config/rateLimits.js';
import { consume } from '../services/rateLimiter.js';
import { findLinkByCode } from '../db/links.js';
import { verifyPassword } from '../utils/password.js';
import { clientKey } from '../utils/clientKey.js';
import { consumeClick, markLimitReached } from '../services/clickLimits.js';
import { toShortUrl } from '../services/links.js';
import logger from '../config/logger.js';

const page = (title, message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6fa;color:#1f2937}main{text-align:center;padding:1rem}h1{margin:0 0 .5rem}p{margin:0;color:#6b7280}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;

// Browsers get a small page, API clients get JSON. With no Accept header (curl) JSON wins.
// Every string here is fixed text, so nothing from the request ends up in the HTML.
const fail = (req, res, status, error, title, message) => {
  res.status(status);
  if (req.accepts(['json', 'html']) === 'html') return res.type('html').send(page(title, message));
  return res.json({ error, message });
};

const unlockPage = (code, notice) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Password required</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6fa;color:#1f2937}main{text-align:center;padding:1rem;max-width:22rem}h1{margin:0 0 .5rem}p{margin:0 0 1rem;color:#6b7280}.notice{color:#b91c1c}input,button{font:inherit;padding:.6rem .8rem;border-radius:.5rem;border:1px solid #d1d5db;width:100%;box-sizing:border-box;margin-bottom:.6rem}button{background:#1f2937;color:#fff;border:0;cursor:pointer}</style></head>
<body><main><h1>Password required</h1><p>This short link is protected. Enter its password to continue.</p>${notice ? `<p class="notice">${notice}</p>` : ''}
<form method="post" action="/${code}/unlock"><input type="password" name="password" autocomplete="current-password" maxlength="128" required autofocus aria-label="Password"><button type="submit">Continue</button></form></main></body></html>`;

const askForPassword = (req, res, status, error, message, notice) => {
  res.status(status);
  if (req.accepts(['json', 'html']) === 'html') return res.type('html').send(unlockPage(req.params.code, notice));
  return res.json({ error, message, unlockUrl: `/${req.params.code}/unlock` });
};

const GONE = {
  expired: ['link_expired', 'Link expired', 'This short link has expired.'],
  disabled: ['link_disabled', 'Link disabled', 'This short link has been disabled.'],
  click_limit: ['link_click_limit_reached', 'Link no longer available', 'This short link has reached its click limit.'],
};

const gone = (req, res, reason) => fail(req, res, 410, ...GONE[reason]);

const spendClick = async (req, res, limit) => {
  const consumed = await consumeClick(limit);
  if (!consumed) {
    fail(req, res, 503, 'service_unavailable', 'Temporarily unavailable', 'Please try again in a moment.');
    return false;
  }
  if (consumed.outcome !== 'allowed') {
    markLimitReached(limit.linkId, toShortUrl).catch((error) =>
      logger.error({ err: error }, 'Could not record that a click limit was reached')
    );
  }
  if (consumed.outcome === 'exhausted') {
    gone(req, res, 'click_limit');
    return false;
  }
  return true;
};

const CACHE_RESULTS = { cache: 'hit', database: 'miss', filter: 'filtered' };

const isPrefetch = (req) => /prefetch|prerender/i.test(req.get('sec-purpose') ?? req.get('purpose') ?? '');

// @route GET /:code
export const redirectToLink = async (req, res) => {
  // Never allow an intermediary or the browser to remember a redirect: a 302 can still be
  // cached if a response says so, and that would hide clicks and outlive expiry or disabling
  res.set('Cache-Control', 'no-store');

  const { code } = req.params;
  if (!isValidCodeShape(code)) {
    redirects.inc({ outcome: 'not_found', cache: 'skipped' });
    return fail(req, res, 404, 'not_found', 'Link not found', 'This short link does not exist.');
  }

  const result = await resolveCode(code);
  const cache = CACHE_RESULTS[result.source];
  res.set('X-Cache', cache.toUpperCase());
  redirects.inc({ outcome: result.status, cache });

  if (result.status === 'redirect') {
    const counted = req.method === 'GET' && !isPrefetch(req);
    if (counted && result.limit && !(await spendClick(req, res, result.limit))) return undefined;
    if (counted) recordClick({ code, userAgent: req.get('user-agent'), referer: req.get('referer') });
    return res.redirect(302, result.url);
  }

  if (result.status === 'protected') {
    return askForPassword(req, res, 403, 'password_required', 'This link is protected by a password');
  }

  if (result.status === 'gone') return gone(req, res, result.reason);

  return fail(req, res, 404, 'not_found', 'Link not found', 'This short link does not exist.');
};

const limitUnlock = async (req, res, code) => {
  if (!rateLimits.enabled) return true;

  const checks = [
    ['unlockAttempt', `${code}:${clientKey(req.ip)}`],
    ['unlockLink', code],
  ];
  for (const [policyName, identity] of checks) {
    const result = await consume(policyName, identity, rateLimits.policies[policyName]);
    if (!result) {
      unlockAttempts.inc({ result: 'unavailable' });
      res.status(503).json({ error: 'service_unavailable', message: 'Temporarily unavailable, please try again shortly' });
      return false;
    }
    if (!result.allowed) {
      unlockAttempts.inc({ result: 'limited' });
      res.set('Retry-After', String(result.retryAfterSeconds));
      askForPassword(req, res, 429, 'too_many_attempts', 'Too many attempts, please wait and try again', 'Too many attempts. Please wait and try again.');
      return false;
    }
  }
  return true;
};

export const unlockLink = async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const { code } = req.params;
  if (!isValidCodeShape(code)) {
    return fail(req, res, 404, 'not_found', 'Link not found', 'This short link does not exist.');
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password === '' || password.length > 128) {
    return askForPassword(req, res, 400, 'password_required', 'Enter the password', 'Enter the password.');
  }

  if (!(await limitUnlock(req, res, code))) return undefined;

  const link = await findLinkByCode(code);
  if (!link) return fail(req, res, 404, 'not_found', 'Link not found', 'This short link does not exist.');
  if (link.disabledAt) return gone(req, res, 'disabled');
  if (link.limitReachedAt) return gone(req, res, 'click_limit');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return gone(req, res, 'expired');

  if (link.passwordHash && !(await verifyPassword(password, link.passwordHash))) {
    unlockAttempts.inc({ result: 'wrong_password' });
    return askForPassword(req, res, 403, 'wrong_password', 'That password is not right', 'That password is not right. Try again.');
  }

  unlockAttempts.inc({ result: link.passwordHash ? 'success' : 'not_protected' });
  if (link.maxClicks && !(await spendClick(req, res, { linkId: String(link.id), max: link.maxClicks }))) return undefined;
  recordClick({ code, userAgent: req.get('user-agent'), referer: req.get('referer') });
  return res.redirect(302, link.longUrl);
};