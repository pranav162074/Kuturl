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
import {
  statsSummaryHandler,
  statsSeriesHandler,
  statsReferrersHandler,
  statsDevicesHandler,
} from '../controllers/statsController.js';
import { qrHandler } from '../controllers/qrController.js';
import { bulkCreateHandler } from '../controllers/bulkLinksController.js';
import {
  createLinkSchema,
  updateLinkSchema,
  listLinksQuerySchema,
  statsSeriesQuerySchema,
  statsReferrersQuerySchema,
  statsDevicesQuerySchema,
  qrQuerySchema,
  bulkCreateSchema,
} from '../utils/validators.js';

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
router.post(
  '/bulk',
  validate(bulkCreateSchema),
  rateLimit('linkCreation', { scope: 'key', cost: (req) => req.body.links.length }),
  idempotency,
  bulkCreateHandler
);
router.get('/', validateQuery(listLinksQuerySchema), listLinksHandler);
router.get('/:code', getLinkHandler);
router.get('/:code/stats', statsSummaryHandler);
router.get('/:code/stats/timeseries', validateQuery(statsSeriesQuerySchema), statsSeriesHandler);
router.get('/:code/stats/referrers', validateQuery(statsReferrersQuerySchema), statsReferrersHandler);
router.get('/:code/stats/devices', validateQuery(statsDevicesQuerySchema), statsDevicesHandler);
router.get('/:code/qr', validateQuery(qrQuerySchema), qrHandler);
router.patch('/:code', validate(updateLinkSchema), updateLinkHandler);
router.delete('/:code', deleteLinkHandler);

export default router;