import { createApiKey } from '../db/apiKeys.js';
import { generateApiKey, hashApiKey, keyPrefix } from '../utils/apiKey.js';

// @route POST /api/v1/keys
export const createKey = async (req, res) => {
  const key = generateApiKey();

  const record = await createApiKey({
    name: req.body.name,
    keyPrefix: keyPrefix(key),
    keyHash: hashApiKey(key),
  });

  // The only moment the key exists in readable form: only its hash is stored
  res.set('Cache-Control', 'no-store').status(201).json({
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt,
    apiKey: key,
    notice: 'Store this key now. It cannot be shown again.',
  });
};