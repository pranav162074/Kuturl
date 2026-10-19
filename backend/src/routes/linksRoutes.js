import express from 'express';
import requireApiKey from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { createLinkHandler } from '../controllers/linksController.js';
import { createLinkSchema } from '../utils/validators.js';

const router = express.Router();

// Authentication comes first, so someone without a key can't probe the validation rules
router.post('/', requireApiKey, validate(createLinkSchema), createLinkHandler);

export default router;