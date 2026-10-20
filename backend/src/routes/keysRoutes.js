import express from 'express';
import requireApiKey from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { createKey, getCurrentKey, revokeCurrentKey } from '../controllers/keysController.js';
import { createApiKeySchema } from '../utils/validators.js';

const router = express.Router();

router.post('/', validate(createApiKeySchema), createKey);
router.get('/me', requireApiKey, getCurrentKey);
router.delete('/me', requireApiKey, revokeCurrentKey);

export default router;