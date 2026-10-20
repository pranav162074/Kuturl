import express from 'express';
import requireApiKey from '../middleware/auth.js';
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

// Authentication comes first for every route, so someone without a key can't probe
// the validation rules or find out which codes exist
router.use(requireApiKey);

router.post('/', validate(createLinkSchema), createLinkHandler);
router.get('/', validateQuery(listLinksQuerySchema), listLinksHandler);
router.get('/:code', getLinkHandler);
router.patch('/:code', validate(updateLinkSchema), updateLinkHandler);
router.delete('/:code', deleteLinkHandler);

export default router;