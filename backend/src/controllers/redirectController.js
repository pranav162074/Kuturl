import { isValidCodeShape } from '../utils/codeFormat.js';
import { resolveCode } from '../services/redirect.js';
import { recordClick } from '../services/clickEvents.js';
import { redirects } from '../config/metrics.js';

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
  res.set('X-Cache', result.source === 'cache' ? 'HIT' : 'MISS');
  redirects.inc({ outcome: result.status, cache: result.source === 'cache' ? 'hit' : 'miss' });

  if (result.status === 'redirect') {
    if (req.method === 'GET' && !isPrefetch(req)) {
      recordClick({ code, userAgent: req.get('user-agent'), referer: req.get('referer') });
    }
    return res.redirect(302, result.url);
  }

  if (result.status === 'gone') {
    return result.reason === 'expired'
      ? fail(req, res, 410, 'link_expired', 'Link expired', 'This short link has expired.')
      : fail(req, res, 410, 'link_disabled', 'Link disabled', 'This short link has been disabled.');
  }

  return fail(req, res, 404, 'not_found', 'Link not found', 'This short link does not exist.');
};