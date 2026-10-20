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

const MAX_ATTEMPTS = 5;

export const toShortUrl = (code) => `${env.baseUrl}/${code}`;

// The code comes from the id, and the scramble can never produce the same code twice. A
// collision is still possible once custom aliases exist (someone may pick a word that equals
// a code we would generate later), so a taken code just means "take the next id and retry".
export const createLink = async ({ apiKeyId, longUrl, expiresAt }) => {
  for (let attempt = 1; ; attempt += 1) {
    const id = await reserveLinkId();
    try {
      return await insertLink({ id, code: codes.encode(id), longUrl, apiKeyId, expiresAt });
    } catch (error) {
      if (!(error instanceof CodeTakenError) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
};

export const getLink = (code, apiKeyId) => findOwnedLink(code, apiKeyId);

export const listLinks = (apiKeyId, options) => listLinksByOwner(apiKeyId, options);

// Postgres changes first, then the cache is overwritten with the new state, so redirects
// follow the change straight away instead of after the old entry expires.
// Returns null when the link does not exist or belongs to someone else.
export const changeLink = async (code, apiKeyId, changes) => {
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