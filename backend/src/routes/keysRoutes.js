import express from 'express';
import validate from '../middleware/validate.js';
import { createKey } from '../controllers/keysController.js';
import { createApiKeySchema } from '../utils/validators.js';

const router = express.Router();

router.post('/', validate(createApiKeySchema), createKey);

export default router;