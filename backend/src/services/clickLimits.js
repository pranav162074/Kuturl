import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import redis from '../config/redis.js';
import logger from '../config/logger.js';
import webhookSettings from '../config/webhooks.js';
import { query } from '../config/db.js';
import { withTransaction } from '../db/transaction.js';
import { enqueueEvent } from '../db/webhooks.js';
import { withTimeout } from '../utils/timeout.js';
import { setEntry, entryFromLink } from './linkCache.js';
import { clickLimitChecks } from '../config/metrics.js';

redis.defineCommand('clickLimit', {
  numberOfKeys: 1,
  lua: readFileSync(new URL('../lua/clickLimit.lua', import.meta.url), 'utf8'),
});

const TIMEOUT_MS = 250;

export const counterKey = (linkId) => `clicklimit:${linkId}`;

const seedFor = async (linkId) => {
  const { rows } = await query('SELECT coalesce(sum(clicks), 0)::bigint AS n FROM link_stats_hourly WHERE link_id = $1', [linkId]);
  return String(rows[0].n);
};

export const consumeClick = async ({ linkId, max }) => {
  try {
    let count = await withTimeout(redis.clickLimit(counterKey(linkId), ''), TIMEOUT_MS);
    if (count === -1) count = await withTimeout(redis.clickLimit(counterKey(linkId), await seedFor(linkId)), TIMEOUT_MS);
    const outcome = count < max ? 'allowed' : count === max ? 'last' : 'exhausted';
    clickLimitChecks.inc({ outcome });
    return { count, outcome };
  } catch (error) {
    clickLimitChecks.inc({ outcome: 'unavailable' });
    logger.warn({ err: error }, 'Click limit could not be checked');
    return null;
  }
};

const toPayloadLink = (row, shortUrl) => ({
  code: row.code,
  shortUrl,
  longUrl: row.long_url,
  maxClicks: row.max_clicks,
  reachedAt: row.limit_reached_at,
});

export const markLimitReached = async (linkId, toShortUrl) => {
  const reached = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE links SET limit_reached_at = now()
       WHERE id = $1 AND limit_reached_at IS NULL AND max_clicks IS NOT NULL
       RETURNING *`,
      [linkId]
    );
    const row = rows[0];
    if (!row) return null;

    const event = {
      id: randomUUID(),
      type: 'link.click_limit_reached',
      createdAt: new Date().toISOString(),
      data: { link: toPayloadLink(row, toShortUrl(row.code)) },
    };
    const queued = await enqueueEvent({ apiKeyId: row.api_key_id, event }, client);
    return { row, queued };
  });

  if (!reached) return false;

  await setEntry(reached.row.code, entryFromLink({ limitReachedAt: reached.row.limit_reached_at }));
  if (reached.queued > 0) {
    await withTimeout(redis.publish(webhookSettings.nudgeChannel, '1'), TIMEOUT_MS).catch(() => {});
  }
  return true;
};

export const forgetCounter = (linkId) => withTimeout(redis.del(counterKey(linkId)), TIMEOUT_MS).catch(() => {});
