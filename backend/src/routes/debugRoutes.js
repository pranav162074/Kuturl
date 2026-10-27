import express from 'express';
import env from '../config/env.js';

const router = express.Router();

router.get('/debug/client-ip', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!env.debugClientIp) return res.status(404).json({ error: 'not_found', message: 'Route not found' });

  res.json({
    ip: req.ip,
    ips: req.ips,
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: req.get('x-forwarded-for') ?? null,
    trustProxy: env.trustProxy,
  });
});

export default router;
