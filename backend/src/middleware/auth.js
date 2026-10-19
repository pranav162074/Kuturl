import { findActiveApiKeyByHash } from '../db/apiKeys.js';
import { hashApiKey, looksLikeApiKey } from '../utils/apiKey.js';

const unauthorized = (res) =>
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .json({ error: 'unauthorized', message: 'Missing or invalid API key' });

// Expects "Authorization: Bearer kt_...". A missing header, a malformed key, an unknown key
// and a revoked key all get the same answer, so the response never says which one it was.
const requireApiKey = async (req, res, next) => {
  const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match || !looksLikeApiKey(match[1])) return unauthorized(res);

  const apiKey = await findActiveApiKeyByHash(hashApiKey(match[1]));
  if (!apiKey) return unauthorized(res);

  req.apiKey = apiKey;
  next();
};

export default requireApiKey;