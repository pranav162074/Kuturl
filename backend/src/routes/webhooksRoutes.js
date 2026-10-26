import express from 'express';
import requireApiKey from '../middleware/auth.js';
import rateLimit from '../middleware/rateLimit.js';
import validate from '../middleware/validate.js';
import { createWebhookSchema } from '../utils/validators.js';
import {
  createEndpointHandler,
  listEndpointsHandler,
  deleteEndpointHandler,
  testEndpointHandler,
  listDeliveriesHandler,
} from '../controllers/webhooksController.js';

const router = express.Router();

router.use(requireApiKey);
router.use(rateLimit('apiKey', { scope: 'key' }));

router.post('/', validate(createWebhookSchema), createEndpointHandler);
router.get('/', listEndpointsHandler);
router.delete('/:id', deleteEndpointHandler);
router.post('/:id/test', testEndpointHandler);
router.get('/:id/deliveries', listDeliveriesHandler);

export default router;
