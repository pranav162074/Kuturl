import env from '../config/env.js';
import {
  reserveLinkId,
  insertLink,
  findOwnedLink,
  listLinksByOwner,
  updateOwnedLink,
  deleteOwnedLink,
} from '../db/links.js';
import { CodeTakenError } from '../db/errors.js';
import { setEntry, entryFromLink } from './linkCache.js';
import codes from './codes.js';
import linkFilter from './linkFilter.js';
import { hashPassword } from '../utils/password.js';

const MAX_ATTEMPTS = 5;

export const toShortUrl = (code) => `${env.baseUrl}/${code}`;

// A chosen alias gets exactly one attempt: if it is taken, the caller has to choose another,
// and the unique indexes (not a check-then-insert) decide who won when requests race.
// Any cached "this code does not exist" answer for it must go, otherwise someone who opened
// the link a moment before it existed would keep getting a 404. The entry is overwritten
// and not deleted, and a late cache fill cannot undo it, because fills never overwrite.
const createWithAlias = async ({ apiKeyId, longUrl, expiresAt, alias, passwordHash }) => {
  const id = await reserveLinkId();
  const link = await insertLink({ id, code: alias, longUrl, apiKeyId, expiresAt, isCustom: true, passwordHash });
  await setEntry(alias, entryFromLink(link));
  return link;
};

// A generated code comes from the id, and the scramble can never produce the same code twice.
// It can still collide with an alias somebody chose earlier, in which case the next id is tried.
const createGenerated = async ({ apiKeyId, longUrl, expiresAt, passwordHash }) => {
  for (let attempt = 1; ; attempt += 1) {
    const id = await reserveLinkId();
    try {
      return await insertLink({ id, code: codes.encode(id), longUrl, apiKeyId, expiresAt, passwordHash });
    } catch (error) {
      if (!(error instanceof CodeTakenError) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
};

export const createLink = async ({ password, ...input }) => {
  const prepared = { ...input, passwordHash: password ? await hashPassword(password) : null };
  const link = await (prepared.alias ? createWithAlias(prepared) : createGenerated(prepared));
  await linkFilter.announce(link.code);
  return link;
};

export const getLink = (code, apiKeyId) => findOwnedLink(code, apiKeyId);

export const listLinks = (apiKeyId, options) => listLinksByOwner(apiKeyId, options);

// Postgres changes first, then the cache is overwritten with the new state, so redirects
// follow the change straight away instead of after the old entry expires.
// Returns null when the link does not exist or belongs to someone else.
export const changeLink = async (code, apiKeyId, { password, ...changes }) => {
  if (password !== undefined) changes.passwordHash = password === null ? null : await hashPassword(password);
  const link = await updateOwnedLink(code, apiKeyId, changes);
  if (!link) return null;

  await setEntry(code, entryFromLink(link));
  return link;
};

// A deleted link is cached as "missing", so it stops redirecting at once
export const removeLink = async (code, apiKeyId) => {
  const deleted = await deleteOwnedLink(code, apiKeyId);
  if (deleted) await setEntry(code, entryFromLink(null));
  return deleted;
};