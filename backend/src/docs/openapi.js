import { MAX_BULK_LINKS } from '../utils/validators.js';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example && { example }) } });
const error = (description) => ({ description, content: json(ref('Error')) });
const validationError = { description: 'The request is not valid', content: json(ref('ValidationError')) };
const unauthorized = error('Missing, invalid or revoked API key');
const notFound = error('Not found, or owned by another API key');
const limited = {
  description: 'Rate limited. Retry-After says how many seconds to wait.',
  headers: { 'Retry-After': { schema: { type: 'integer' } } },
  content: json(ref('RateLimited')),
};
const codeParam = { name: 'code', in: 'path', required: true, description: 'Short code or alias', schema: { type: 'string' } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[1-9][0-9]*$' } };
const secured = [{ apiKey: [] }];
const dateTime = { type: 'string', format: 'date-time' };
const range = (description) => [
  { name: 'from', in: 'query', description: `${description} start (ISO 8601 with offset)`, schema: dateTime },
  { name: 'to', in: 'query', description: `${description} end, exclusive`, schema: dateTime },
];

export default {
  openapi: '3.1.0',
  info: {
    title: 'Kuturl API',
    version: '1.0.0',
    description:
      'A URL shortener API. Create an API key once, then send it as `Authorization: Bearer kt_...` on every call under /api/v1 except key creation. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.',
  },
  tags: [
    { name: 'Keys', description: 'Self-service API keys. A key is shown once and stored only as a hash.' },
    { name: 'Links', description: 'Create and manage short links.' },
    { name: 'Stats', description: 'Click statistics for a link. Times are UTC.' },
    { name: 'Webhooks', description: 'Signed HTTP callbacks when one of your links reaches its click limit.' },
    { name: 'Redirects', description: 'The public side: following short links.' },
    { name: 'Operations', description: 'Health checks, metrics and these docs.' },
  ],
  components: {
    securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key starting with kt_' } },
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'message'],
        properties: { error: { type: 'string' }, message: { type: 'string' } },
        example: { error: 'not_found', message: 'Link not found' },
      },
      ValidationError: {
        type: 'object',
        required: ['error', 'message', 'details'],
        properties: {
          error: { const: 'validation_error' },
          message: { type: 'string', description: 'The first problem found' },
          details: {
            type: 'array',
            items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
          },
        },
        example: { error: 'validation_error', message: 'URL is required', details: [{ field: 'url', message: 'URL is required' }] },
      },
      RateLimited: {
        type: 'object',
        properties: { error: { const: 'rate_limited' }, message: { type: 'string' }, retryAfterSeconds: { type: 'integer' } },
      },
      NewApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          keyPrefix: { type: 'string' },
          createdAt: dateTime,
          apiKey: { type: 'string', description: 'Shown only in this response' },
          notice: { type: 'string' },
        },
      },
      ApiKey: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, keyPrefix: { type: 'string' }, createdAt: dateTime },
      },
      CreateLink: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 2048, description: 'http or https, public hosts only' },
          alias: {
            type: 'string',
            minLength: 3,
            maxLength: 32,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$',
            description: 'Your own code instead of a generated one: letters, numbers, - and _, starting and ending with a letter or number. Unique regardless of case.',
          },
          expiresAt: { ...dateTime, description: 'At least a minute and at most 10 years ahead' },
          password: { type: 'string', minLength: 6, maxLength: 128, description: 'Visitors must enter it before being redirected' },
          maxClicks: { type: 'integer', minimum: 1, maximum: 1_000_000_000, description: 'After this many clicks the link answers 410' },
        },
        example: { url: 'https://example.com/a/long/path', alias: 'spring-sale', maxClicks: 500 },
      },
      UpdateLink: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        description: 'The destination cannot be changed; create a new link instead.',
        properties: {
          disabled: { type: 'boolean' },
          expiresAt: { oneOf: [dateTime, { type: 'null' }] },
          password: { oneOf: [{ type: 'string', minLength: 6, maxLength: 128 }, { type: 'null' }] },
          maxClicks: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        },
      },
      Link: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          shortUrl: { type: 'string' },
          longUrl: { type: 'string' },
          expiresAt: { oneOf: [dateTime, { type: 'null' }] },
          createdAt: dateTime,
        },
        example: {
          code: 'aB3xY9k',
          shortUrl: 'https://kuturl.onrender.com/aB3xY9k',
          longUrl: 'https://example.com/a/long/path',
          expiresAt: null,
          createdAt: '2026-10-27T10:00:00.000Z',
        },
      },
      LinkDetails: {
        allOf: [
          ref('Link'),
          {
            type: 'object',
            properties: {
              status: { enum: ['active', 'disabled', 'expired', 'click_limit_reached'] },
              disabledAt: { oneOf: [dateTime, { type: 'null' }] },
              isCustom: { type: 'boolean' },
              passwordProtected: { type: 'boolean' },
              maxClicks: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              clickLimitReachedAt: { oneOf: [dateTime, { type: 'null' }] },
            },
          },
        ],
      },
      BulkResult: {
        type: 'object',
        properties: {
          created: { type: 'integer' },
          failed: { type: 'integer' },
          results: {
            type: 'array',
            description: 'One entry per requested link, in order. Created entries also carry the Link fields.',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                status: { type: 'integer', examples: [201, 400, 409] },
                code: { type: 'string' },
                error: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      WebhookEndpoint: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          events: { type: 'array', items: { enum: ['link.click_limit_reached'] } },
          createdAt: dateTime,
        },
      },
      WebhookDelivery: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string', format: 'uuid' },
          eventType: { type: 'string' },
          status: { enum: ['pending', 'delivered', 'failed'] },
          attempts: { type: 'integer' },
          lastStatus: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          nextAttemptAt: { oneOf: [dateTime, { type: 'null' }] },
          createdAt: dateTime,
          deliveredAt: { oneOf: [dateTime, { type: 'null' }] },
        },
      },
    },
  },
  paths: {
    '/api/v1/keys': {
      post: {
        tags: ['Keys'],
        summary: 'Create an API key',
        description: 'Limited to 5 new keys per hour per IP address. Refused with 503 while the rate limiter is unavailable.',
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 100 } } }, { name: 'my app' }),
        },
        responses: { 201: { description: 'Created. Store the key now.', content: json(ref('NewApiKey')) }, 400: validationError, 429: limited, 503: error('Rate limiter unavailable') },
      },
    },
    '/api/v1/keys/me': {
      get: { tags: ['Keys'], summary: 'Show the current key', security: secured, responses: { 200: { description: 'The key', content: json(ref('ApiKey')) }, 401: unauthorized } },
      delete: {
        tags: ['Keys'],
        summary: 'Revoke the current key',
        description: 'Its links keep redirecting, but can no longer be managed.',
        security: secured,
        responses: { 204: { description: 'Revoked' }, 401: unauthorized },
      },
    },
    '/api/v1/links': {
      post: {
        tags: ['Links'],
        summary: 'Create a link',
        security: secured,
        parameters: [{ name: 'Idempotency-Key', in: 'header', description: 'Retry safely: the same key and body return the first response for 24 hours', schema: { type: 'string', maxLength: 255 } }],
        requestBody: { required: true, content: json(ref('CreateLink')) },
        responses: {
          201: { description: 'Created', content: json(ref('Link')) },
          400: validationError,
          401: unauthorized,
          409: error('Alias taken, or the same Idempotency-Key is still being processed'),
          422: error('Idempotency-Key reused with a different request'),
          429: limited,
        },
      },
      get: {
        tags: ['Links'],
        summary: 'List your links, newest first',
        security: secured,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', description: 'nextCursor from the previous page', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'A page of links',
            content: json({ type: 'object', properties: { links: { type: 'array', items: ref('LinkDetails') }, nextCursor: { type: ['string', 'null'] } } }),
          },
          400: validationError,
          401: unauthorized,
        },
      },
    },
    '/api/v1/links/bulk': {
      post: {
        tags: ['Links'],
        summary: `Create up to ${MAX_BULK_LINKS} links at once`,
        description: 'Each item follows the same rules as single creation. Costs one rate limit token per link. Accepts Idempotency-Key.',
        security: secured,
        requestBody: {
          required: true,
          content: json(
            { type: 'object', required: ['links'], properties: { links: { type: 'array', minItems: 1, maxItems: MAX_BULK_LINKS, items: ref('CreateLink') } } },
            { links: [{ url: 'https://example.com/one' }, { url: 'https://example.com/two', alias: 'two' }] }
          ),
        },
        responses: {
          201: { description: 'Every link was created', content: json(ref('BulkResult')) },
          207: { description: 'Some links failed; see results', content: json(ref('BulkResult')) },
          400: validationError,
          401: unauthorized,
          429: limited,
        },
      },
    },
    '/api/v1/links/{code}': {
      parameters: [codeParam],
      get: { tags: ['Links'], summary: 'Show a link', security: secured, responses: { 200: { description: 'The link', content: json(ref('LinkDetails')) }, 401: unauthorized, 404: notFound } },
      patch: {
        tags: ['Links'],
        summary: 'Change a link',
        security: secured,
        requestBody: { required: true, content: json(ref('UpdateLink')) },
        responses: { 200: { description: 'The updated link', content: json(ref('LinkDetails')) }, 400: validationError, 401: unauthorized, 404: notFound },
      },
      delete: { tags: ['Links'], summary: 'Delete a link', security: secured, responses: { 204: { description: 'Deleted' }, 401: unauthorized, 404: notFound } },
    },
    '/api/v1/links/{code}/qr': {
      parameters: [codeParam],
      get: {
        tags: ['Links'],
        summary: 'QR code for a link',
        description: 'Cacheable: send the ETag back in If-None-Match to get 304.',
        security: secured,
        parameters: [
          { name: 'format', in: 'query', schema: { enum: ['svg', 'png'], default: 'svg' } },
          { name: 'size', in: 'query', schema: { type: 'integer', minimum: 128, maximum: 1024, default: 512 } },
          { name: 'margin', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 10, default: 2 } },
          { name: 'ecc', in: 'query', description: 'Error correction level', schema: { enum: ['L', 'M', 'Q', 'H'], default: 'M' } },
        ],
        responses: {
          200: { description: 'The image', content: { 'image/svg+xml': {}, 'image/png': {} } },
          304: { description: 'Not modified' },
          400: validationError,
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/api/v1/links/{code}/stats': {
      parameters: [codeParam],
      get: {
        tags: ['Stats'],
        summary: 'Click totals',
        security: secured,
        responses: {
          200: {
            description: 'Totals over rolling, hour-aligned windows',
            content: json(
              {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  totalClicks: { type: 'integer' },
                  last24Hours: { type: 'integer' },
                  last7Days: { type: 'integer' },
                  last30Days: { type: 'integer' },
                  lastClickAt: { oneOf: [dateTime, { type: 'null' }] },
                  timezone: { const: 'UTC' },
                },
              },
              { code: 'aB3xY9k', totalClicks: 1520, last24Hours: 41, last7Days: 302, last30Days: 1180, lastClickAt: '2026-10-27T09:58:12.000Z', timezone: 'UTC' }
            ),
          },
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/api/v1/links/{code}/stats/timeseries': {
      parameters: [codeParam],
      get: {
        tags: ['Stats'],
        summary: 'Clicks per hour or per UTC day',
        description: 'Empty buckets are returned as 0. At most 744 hourly or 366 daily points. Defaults to the last 24 hours or 30 days.',
        security: secured,
        parameters: [{ name: 'interval', in: 'query', schema: { enum: ['hour', 'day'], default: 'day' } }, ...range('Range')],
        responses: {
          200: {
            description: 'The series',
            content: json({
              type: 'object',
              properties: {
                interval: { enum: ['hour', 'day'] },
                from: dateTime,
                to: dateTime,
                totalClicks: { type: 'integer' },
                points: { type: 'array', items: { type: 'object', properties: { at: dateTime, clicks: { type: 'integer' } } } },
              },
            }),
          },
          400: validationError,
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/api/v1/links/{code}/stats/referrers': {
      parameters: [codeParam],
      get: {
        tags: ['Stats'],
        summary: 'Top referring hosts',
        description: 'Direct visits have host null. At most 186 days; defaults to the last 30.',
        security: secured,
        parameters: [...range('Range'), { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }],
        responses: {
          200: {
            description: 'Referrers, most clicks first',
            content: json({
              type: 'object',
              properties: { referrers: { type: 'array', items: { type: 'object', properties: { host: { type: ['string', 'null'] }, clicks: { type: 'integer' } } } } },
            }),
          },
          400: validationError,
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/api/v1/links/{code}/stats/devices': {
      parameters: [codeParam],
      get: {
        tags: ['Stats'],
        summary: 'Clicks by device class',
        description: 'At most 186 days; defaults to the last 30.',
        security: secured,
        parameters: range('Range'),
        responses: {
          200: {
            description: 'Every device class, including zeros',
            content: json(
              { type: 'object', properties: { totalClicks: { type: 'integer' }, devices: { type: 'object', additionalProperties: { type: 'integer' } } } },
              { totalClicks: 4, devices: { desktop: 1, mobile: 2, tablet: 0, bot: 1, other: 0 } }
            ),
          },
          400: validationError,
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/api/v1/webhooks': {
      post: {
        tags: ['Webhooks'],
        summary: 'Register an endpoint',
        description:
          'Deliveries are POSTed as JSON with a `Kuturl-Signature: t=<unix seconds>,v1=<hex>` header, where v1 is HMAC-SHA256 of `t + "." + body` with your secret. Reject signatures older than 5 minutes. Deliveries can repeat, so ignore event ids you have already handled.',
        security: secured,
        requestBody: {
          required: true,
          content: json(
            { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'https only, public hosts' }, events: { type: 'array', items: { enum: ['link.click_limit_reached'] } } } },
            { url: 'https://example.com/hooks/kuturl' }
          ),
        },
        responses: {
          201: { description: 'Registered. The secret is shown only here.', content: json({ allOf: [ref('WebhookEndpoint'), { type: 'object', properties: { secret: { type: 'string' } } }] }) },
          400: validationError,
          401: unauthorized,
          409: error('Already at 5 endpoints'),
        },
      },
      get: {
        tags: ['Webhooks'],
        summary: 'List endpoints',
        security: secured,
        responses: { 200: { description: 'Your endpoints', content: json({ type: 'object', properties: { endpoints: { type: 'array', items: ref('WebhookEndpoint') } } }) }, 401: unauthorized },
      },
    },
    '/api/v1/webhooks/{id}': {
      parameters: [idParam],
      delete: { tags: ['Webhooks'], summary: 'Remove an endpoint', security: secured, responses: { 204: { description: 'Removed, with its delivery history' }, 401: unauthorized, 404: notFound } },
    },
    '/api/v1/webhooks/{id}/test': {
      parameters: [idParam],
      post: {
        tags: ['Webhooks'],
        summary: 'Send a test event',
        security: secured,
        responses: { 202: { description: 'Queued', content: json({ type: 'object', properties: { eventId: { type: 'string' }, queued: { type: 'boolean' } } }) }, 401: unauthorized, 404: notFound },
      },
    },
    '/api/v1/webhooks/{id}/deliveries': {
      parameters: [idParam],
      get: {
        tags: ['Webhooks'],
        summary: 'Recent deliveries',
        description: 'The last 50 attempts. Failed deliveries are retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and 6 h, then given up.',
        security: secured,
        responses: {
          200: { description: 'Deliveries, newest first', content: json({ type: 'object', properties: { deliveries: { type: 'array', items: ref('WebhookDelivery') } } }) },
          401: unauthorized,
          404: notFound,
        },
      },
    },
    '/{code}': {
      parameters: [codeParam],
      get: {
        tags: ['Redirects'],
        summary: 'Follow a short link',
        description: 'Browsers get small HTML pages for errors; API clients get JSON. Responses are never cached.',
        responses: {
          302: { description: 'Redirect to the destination', headers: { Location: { schema: { type: 'string' } } } },
          403: error('Password required (browsers get a password form)'),
          404: error('No such link'),
          410: error('Expired, disabled, or out of clicks'),
          503: error('A click-limited link while the counter is unavailable'),
        },
      },
    },
    '/{code}/unlock': {
      parameters: [codeParam],
      post: {
        tags: ['Redirects'],
        summary: 'Open a password-protected link',
        description: 'Accepts a form post or JSON. Limited to 5 tries per visitor per link per 15 minutes, and 50 per link per hour.',
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { password: { type: 'string' } } } },
            ...json({ type: 'object', properties: { password: { type: 'string' } } }),
          },
        },
        responses: {
          302: { description: 'Right password: redirect to the destination' },
          400: error('No password sent'),
          403: error('Wrong password'),
          404: error('No such link'),
          410: error('Expired, disabled, or out of clicks'),
          429: limited,
          503: error('Limiter unavailable'),
        },
      },
    },
    '/ping': { get: { tags: ['Operations'], summary: 'Liveness', responses: { 200: { description: 'The process is up', content: json({ type: 'object', properties: { ok: { const: true } } }) } } } },
    '/health': {
      get: {
        tags: ['Operations'],
        summary: 'Readiness',
        description: 'Postgres is required; losing Redis only degrades the service.',
        responses: {
          200: { description: 'ok or degraded', content: json({ type: 'object', properties: { status: { enum: ['ok', 'degraded'] }, postgres: { enum: ['ok', 'down'] }, redis: { enum: ['ok', 'down'] } } }) },
          503: { description: 'Postgres is down' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operations'],
        summary: 'Prometheus metrics',
        description: 'Needs `Authorization: Bearer <METRICS_TOKEN>` when that is set. Off in production without a token.',
        responses: { 200: { description: 'Prometheus text format', content: { 'text/plain': {} } }, 401: error('Wrong or missing metrics token'), 404: error('Metrics are switched off') },
      },
    },
    '/debug/client-ip': {
      get: {
        tags: ['Operations'],
        summary: 'Show the client address the app sees',
        description: 'Off unless DEBUG_CLIENT_IP=true. Used once after deploying, to set TRUST_PROXY to the number of proxies in front of the app.',
        responses: {
          200: {
            description: 'What Express made of the request',
            content: json({
              type: 'object',
              properties: {
                ip: { type: 'string' },
                ips: { type: 'array', items: { type: 'string' } },
                remoteAddress: { type: 'string' },
                forwardedFor: { type: ['string', 'null'] },
                trustProxy: { type: 'integer' },
              },
            }),
          },
          404: error('Switched off'),
        },
      },
    },
    '/docs': { get: { tags: ['Operations'], summary: 'This documentation', responses: { 200: { description: 'HTML', content: { 'text/html': {} } } } } },
    '/openapi.json': { get: { tags: ['Operations'], summary: 'The OpenAPI document', responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': {} } } } } },
  },
};
