import express from 'express';
import { metricsResponse } from '../config/metrics.js';

const router = express.Router();

router.get('/metrics', async (req, res) => {
  const { status, headers, body } = await metricsResponse(req.get('authorization'));
  res.status(status).set(headers).send(body);
});

export default router;
