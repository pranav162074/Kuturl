import express from 'express';
import requireApiKey from '../middleware/auth.js';
import rateLimit from '../middleware/rateLimit.js';
import validate from '../middleware/validate.js';
import { createKey, getCurrentKey, revokeCurrentKey } from '../controllers/keysController.js';
import { createApiKeySchema } from '../utils/validators.js';

const router = express.Router();

router.post('/', rateLimit('keyCreation', { scope: 'ip' }), validate(createApiKeySchema), createKey);
router.get('/me', requireApiKey, rateLimit('apiKey', { scope: 'key' }), getCurrentKey);
router.delete('/me', requireApiKey, rateLimit('apiKey', { scope: 'key' }), revokeCurrentKey);

export default router;