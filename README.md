# Kuturl

Kuturl is a URL shortener. Paste a long URL on the home page or call the API, and every visit to the short link is redirected, counted and turned into statistics. Most of the work is in the backend; the web page is a small plain-JavaScript client of the same public API.

I built it to practise the parts of backend work that only show up under real traffic: caching, rate limiting, idempotent writes, asynchronous pipelines, and making several instances of the same service behave as one.

Node.js 22, Express 5, PostgreSQL (Neon), Redis (Redis Cloud), Vitest, GitHub Actions. Everything runs on free plans.

## Features

- A web page at `/` to shorten links, see clicks, referrers and devices, get QR codes, and disable or delete links
- Short links with a generated code or your own alias, optional expiry, password and click limit
- Bulk creation of up to 100 links in one request, with a result for every item
- Click statistics: totals, hourly and daily series, top referrers, device classes
- QR codes for any link, as SVG or PNG
- Webhooks, signed with HMAC, when a link reaches its click limit
- `Idempotency-Key` support, so a retried request never creates a second link
- Per-IP and per-key rate limits
- Prometheus metrics at `/metrics` and structured JSON logs
- API documentation at `/docs`, generated from an OpenAPI 3.1 document at `/openapi.json`

## Architecture

```
                      +------------------------- web process -------------------------+
 client --HTTPS-->    |  Express: auth -> rate limit -> validation -> handler          |
                      |  Bloom filter (in memory)  |  request coalescing (in memory)   |
                      +--------------+------------------------------+-----------------+
                                     |                              |
                          cache, counters, limits          links, keys, stats,
                          click stream, pub/sub            webhooks (source of truth)
                                     |                              |
                                +----v----+                   +-----v------+
                                |  Redis  |                   | PostgreSQL |
                                +----^----+                   +-----^------+
                                     |                              |
                      +--------------+---- worker process ----------+-----------------+
                      |  click worker: stream -> clicks + hourly rollups              |
                      |  webhook dispatcher: outbox -> signed HTTP POSTs, retries     |
                      +----------------------------------------------------------------+
```

The worker can run on its own (`npm run worker`), as many copies as needed, or inside the web process with `RUN_WORKER=true`. The free Render plan has no background workers, so the deployed copy runs everything in one process.

### Following a link (`GET /:code`)

1. The code is checked against an in-memory Bloom filter. If it cannot exist, the answer is 404 without touching Redis or Postgres.
2. Redis is checked for a cached entry. A miss goes to Postgres, and concurrent misses for the same code share one query.
3. The entry says whether the link is active, expired, disabled, password-protected, click-limited or missing. Missing links are cached too, for 30 seconds.
4. Click-limited links spend one click from an atomic Redis counter.
5. The visitor gets a 302 (never cached by browsers), and a click event is added to a Redis Stream without waiting for it.

### Recording a click

The worker reads the stream in batches through a consumer group. For each batch it inserts the clicks and adds them to the hourly totals in a single SQL statement, then acknowledges and deletes the events. Clicks are stored in monthly partitions and kept for 6 months. The hourly totals are kept for good.

## Design decisions

**The web page is just another API client.** It has no private endpoints. On the first link it creates an API key and keeps it in the browser, so there is no sign-up; the key can be copied to another device or used from scripts. The page runs under a strict content security policy (no inline scripts), and only ever writes text into the page, never HTML.

**Short codes come from a sequence, not randomness.** Each link id comes from a Postgres sequence and is passed through a keyed Feistel permutation, then written in base62. Codes are always 7 characters, never collide, and don't reveal how many links exist.

**Redirects are 302, with `Cache-Control: no-store`.** A 301 would be cached by browsers, which would hide clicks and keep working after a link expires or is disabled.

**The cache is an optimisation, not a requirement.** Redis calls on the request path have short timeouts, and the cache and the rate limiter stop calling Redis for a few seconds after a failure. If Redis goes away, redirects get slower but keep working. The exceptions are deliberate: key creation, password guesses and click-limited links refuse to run without their limits.

**Clicks are delivered at least once, and counted exactly once.** A click insert and its hourly total are one statement, and the total only counts rows that were actually inserted (`ON CONFLICT DO NOTHING ... RETURNING`). Redelivered events add nothing.

**Idempotency lives in Postgres.** Redis has 30 MB on the free plan. A unique key on (API key, idempotency key) is the lock, a request fingerprint catches a key reused with a different body, and abandoned requests can be taken over after 30 seconds.

**Webhooks use an outbox.** Reaching a click limit and recording the webhook event happen in one transaction, so they cannot disagree. A dispatcher claims due deliveries with `FOR UPDATE SKIP LOCKED`, signs them like Stripe does, and retries with growing delays for about 11 hours.

**Outbound requests are checked at connection time.** Webhook URLs are user input, so the hostname is resolved and the resolved address must be public. The connection is pinned to that checked address, which stops DNS tricks that point a public name at an internal one.

**The database is allowed to sleep.** Neon's free compute pauses when idle. Nothing in Kuturl polls Postgres every few seconds: the Bloom filter learns new codes over Redis pub/sub, and the webhook dispatcher sleeps until the next retry is due or it is nudged.

**No IP addresses are stored.** Clicks keep the referrer host and a device class. Rate limiting groups IPv6 clients by /64.

## Measured

All of these come from the test suite or from scripts in this repository, run against PostgreSQL 16 and Redis 7.

| What | Result |
|---|---|
| 100 simultaneous cache misses for one link | 1 database query (100 without coalescing) |
| 50 simultaneous visitors on a link limited to 10 clicks | exactly 10 redirects |
| 8 identical requests with one `Idempotency-Key` | 1 link created |
| Bloom filter at 100k links, 1% target | 0.998% false positives, 117 KB, no false negatives |
| Click stream at its maximum length (20,000 events) | 2.0 MB of Redis memory |
| Password check (scrypt, N = 32768) | about 66 ms and 32 MB |
| `/metrics` scrape | about 2 ms; 10 scrapes cost 3 Redis commands |
| All-time total for a link with 200k clicks | 16.6 ms before a covering index, 0.6 ms after |
| Device breakdown over 180 days | 52.6 ms before, 29.9 ms after (86% fewer pages read) |

How the stats queries were tuned is written up in [backend/docs/stats-query-plans.md](backend/docs/stats-query-plans.md).

## API

The full reference is at `/docs`. The short version:

| Method | Path | What it does |
|---|---|---|
| POST | `/api/v1/keys` | Create an API key (shown once) |
| GET, DELETE | `/api/v1/keys/me` | Show or revoke the current key |
| POST | `/api/v1/links` | Create a link |
| POST | `/api/v1/links/bulk` | Create up to 100 links |
| GET | `/api/v1/links` | List your links, page by page |
| GET, PATCH, DELETE | `/api/v1/links/{code}` | Show, change or delete a link |
| GET | `/api/v1/links/{code}/qr` | QR code (SVG or PNG) |
| GET | `/api/v1/links/{code}/stats` | Click totals |
| GET | `/api/v1/links/{code}/stats/timeseries` | Clicks per hour or day |
| GET | `/api/v1/links/{code}/stats/referrers` | Top referrers |
| GET | `/api/v1/links/{code}/stats/devices` | Clicks by device class |
| POST, GET | `/api/v1/webhooks` | Register or list webhook endpoints |
| DELETE | `/api/v1/webhooks/{id}` | Remove an endpoint |
| POST | `/api/v1/webhooks/{id}/test` | Send a test event |
| GET | `/api/v1/webhooks/{id}/deliveries` | Recent delivery attempts |
| GET | `/{code}` | Follow a short link |
| POST | `/{code}/unlock` | Open a password-protected link |

```
curl -X POST http://localhost:3000/api/v1/keys \
  -H "Content-Type: application/json" -d '{"name":"my app"}'

curl -X POST http://localhost:3000/api/v1/links \
  -H "Authorization: Bearer kt_..." -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/a/long/path"}'
```

## Running it

You need Node.js 20 or later, a PostgreSQL database and a Redis instance. Neon and Redis Cloud both have free plans that work.

```
cd backend
cp .env.example .env      # then fill in DATABASE_URL, DIRECT_URL, REDIS_URL and CODE_SECRET
npm ci
npm run migrate
npm run dev               # the web page and API on http://localhost:3000
npm run dev:worker        # in a second terminal: clicks and webhooks (or set RUN_WORKER=true)
```

Use `npm ci` rather than `npm install`, so the lockfile is not rewritten.

| Setting | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection used by the app (pooled) |
| `DIRECT_URL` | no | Direct connection for migrations; falls back to `DATABASE_URL` |
| `REDIS_URL` | yes | Redis connection |
| `CODE_SECRET` | yes | 16+ characters; keys the short code permutation. Keep it stable. |
| `PUBLIC_URL` | no | Address short links are built on (default `http://localhost:3000`) |
| `PORT`, `LOG_LEVEL`, `NODE_ENV` | no | The usual |
| `RATE_LIMIT_ENABLED` | no | `false` switches rate limiting off |
| `BLOOM_FILTER_ENABLED` | no | `false` switches the Bloom filter off |
| `METRICS_TOKEN` | no | Protects `/metrics`; without it, metrics are off in production |
| `WORKER_METRICS_PORT` | no | Port for a standalone worker's own `/metrics` |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | no | Local experiments only: allows webhooks to localhost |
| `RUN_WORKER` | no | `true` runs the click worker and webhook dispatcher inside the web process |
| `REDIS_KEY_PREFIX` | no | Put in front of every Redis key and channel, so two environments can share one Redis |
| `TRUST_PROXY` | no | How many proxies sit in front of the app (default 1); decides which address counts as the client |
| `DEBUG_CLIENT_IP` | no | `true` turns on `/debug/client-ip`, to find the right `TRUST_PROXY` |

## Deploying

`render.yaml` describes the service for Render's free plan: one web service built from `backend/`, migrations run during the build, `/ping` as the health check, and a deploy only after CI passes on `main`.

1. In Render, choose New, then Blueprint, and pick this repository.
2. Fill in `DATABASE_URL`, `DIRECT_URL` and `REDIS_URL` when asked. `CODE_SECRET` and `METRICS_TOKEN` are generated by Render.
3. Short links are built on the `onrender.com` address automatically. Set `PUBLIC_URL` only for a custom domain.

`CODE_SECRET` must never change once links exist, so keep a copy of the generated value somewhere safe.

On Render a request passes three proxies before it reaches the app: Cloudflare, Render's load balancer, and a proxy on the same machine. That is why `render.yaml` sets `TRUST_PROXY=3`. To check it on another host, set `DEBUG_CLIENT_IP=true`, open `/debug/client-ip` and compare `ip` with your real address. If it shows a proxy address, raise `TRUST_PROXY` by one and try again. Set `DEBUG_CLIENT_IP` back to `false` afterwards. Change it in `render.yaml` rather than the dashboard, because Render applies the file again on every deploy.

## Tests

```
npm run lint
npm test
```

The tests run against a real PostgreSQL and Redis, and refuse to run against anything that is not on `localhost` (or the CI service containers), because they create and delete data. GitHub Actions runs lint, migrations and the full suite on every pull request.

Some tests start two API servers and two workers as separate processes against one database and one Redis, to check that codes, rate limits, idempotency, alias races and click processing stay correct across instances.

## Project layout

```
backend/
  migrations/      SQL migrations (node-pg-migrate)
  scripts/         migrate.js, explainStats.js (query plan benchmark, local only)
  src/
    config/        environment, logger, Postgres pool, Redis, limits, metrics
    routes/        URL to handler wiring
    controllers/   HTTP in, HTTP out
    services/      caching, rate limiting, Bloom filter, links, click limits, webhooks
    db/            SQL, one file per table group
    lua/           Redis scripts (token bucket, click counter)
    worker/        click stream consumer, webhook dispatcher
    docs/          OpenAPI document and the /docs page
    web/           the web page at / (HTML, CSS and plain JavaScript, no build step)
  tests/           Vitest + Supertest
```

## Known limits

- Stats trail clicks by however far behind the worker is, normally a few seconds. Days are UTC; hourly rollups cannot produce exact days for half-hour time zones.
- Totals include bots. The device breakdown shows how many clicks were bots.
- A deleted alias can be claimed again by anyone. A cooldown would prevent an old printed link from pointing somewhere new.
- Request coalescing works per process, so N instances can still send N queries for one cold link.
- If the click stream fills up while the worker is down for a long time, the oldest unprocessed clicks are dropped. Bounded memory was the better trade on a 30 MB Redis.
- Webhook secrets are stored as given, because they are needed to sign deliveries.
- On the free Render plan the service sleeps after 15 minutes without traffic, and the first request after that takes about a minute. Webhook retries that fall due while it sleeps go out when it wakes, and clicks not yet recorded stay in the Redis stream until then.
