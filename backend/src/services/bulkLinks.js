import { reserveLinkIds, insertLinks } from '../db/links.js';
import { setEntry, entryFromLink } from './linkCache.js';
import codes from './codes.js';
import linkFilter from './linkFilter.js';
import { hashPassword } from '../utils/password.js';

const MAX_ATTEMPTS = 5;

const aliasTaken = (index, message = 'That alias is already taken') => ({
  index,
  status: 409,
  error: 'alias_taken',
  message,
});

export const createLinks = async (apiKeyId, items) => {
  const results = new Map();
  const seenAliases = new Map();
  let pending = [];

  for (const item of items) {
    if (item.alias) {
      const key = item.alias.toLowerCase();
      if (seenAliases.has(key)) {
        results.set(item.index, aliasTaken(item.index, 'That alias appears more than once in this request'));
        continue;
      }
      seenAliases.set(key, item.index);
    }
    pending.push(item);
  }

  const hashes = new Map(
    await Promise.all(
      pending.filter((item) => item.password).map(async (item) => [item.index, await hashPassword(item.password)])
    )
  );

  const created = [];
  for (let attempt = 1; pending.length > 0; attempt += 1) {
    const ids = await reserveLinkIds(pending.length);
    const rows = pending.map((item, i) => ({
      index: item.index,
      id: ids[i],
      code: item.alias ?? codes.encode(ids[i]),
      longUrl: item.url,
      apiKeyId,
      isCustom: Boolean(item.alias),
      expiresAt: item.expiresAt ?? null,
      passwordHash: hashes.get(item.index) ?? null,
    }));

    const inserted = new Map((await insertLinks(rows)).map((link) => [link.id, link]));
    const retry = [];

    for (const row of rows) {
      const link = inserted.get(String(row.id));
      if (link) {
        results.set(row.index, { index: row.index, status: 201, link });
        created.push(link);
      } else if (row.isCustom) {
        results.set(row.index, aliasTaken(row.index));
      } else if (attempt >= MAX_ATTEMPTS) {
        results.set(row.index, { index: row.index, status: 500, error: 'internal_error', message: 'Could not allocate a code' });
      } else {
        retry.push(pending.find((item) => item.index === row.index));
      }
    }
    pending = retry;
  }

  await Promise.all(created.filter((link) => link.isCustom).map((link) => setEntry(link.code, entryFromLink(link))));
  await linkFilter.announce(...created.map((link) => link.code));

  return [...results.values()];
};
