import express from 'express';
import requireApiKey from '../middleware/auth.js';
import rateLimit from '../middleware/rateLimit.js';
import idempotency from '../middleware/idempotency.js';
import validate, { validateQuery } from '../middleware/validate.js';
import {
  createLinkHandler,
  listLinksHandler,
  getLinkHandler,
  updateLinkHandler,
  deleteLinkHandler,
} from '../controllers/linksController.js';
import { createLinkSchema, updateLinkSchema, listLinksQuerySchema } from '../utils/validators.js';

const router = express.Router();

router.use(requireApiKey);
router.use(rateLimit('apiKey', { scope: 'key' }));

router.post(
  '/',
  rateLimit('linkCreation', { scope: 'key' }),
  validate(createLinkSchema),
  idempotency,
  createLinkHandler
);
router.get('/', validateQuery(listLinksQuerySchema), listLinksHandler);
router.get('/:code', getLinkHandler);
router.patch('/:code', validate(updateLinkSchema), updateLinkHandler);
router.delete('/:code', deleteLinkHandler);

export default router;