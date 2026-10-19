import env from '../config/env.js';
import { reserveLinkId, insertLink } from '../db/links.js';
import { CodeTakenError } from '../db/errors.js';
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