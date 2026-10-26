import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import logger from './config/logger.js';
import redis from './config/redis.js';
import { watchClickStream } from './config/metrics.js';
import { accessLogOptions } from './config/accessLog.js';
import requestMetrics from './middleware/requestMetrics.js';
import metricsRoutes from './routes/metricsRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import keysRoutes from './routes/keysRoutes.js';
import linksRoutes from './routes/linksRoutes.js';
import redirectRoutes from './routes/redirectRoutes.js';
import rateLimit from './middleware/rateLimit.js';

const app = express();

// Render and most hosts put a proxy in front of the app. Without this, every client
// looks like it has the proxy's IP, which would break per-IP rate limiting later.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Every request gets an id, returned in the X-Request-Id header and attached to every log
// line for that request. A client-supplied id is kept only if it is short and harmless.
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const supplied = req.headers['x-request-id'];
      const id = typeof supplied === 'string' && /^[\w-]{1,64}$/.test(supplied) ? supplied : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Health checks run constantly and would drown out the useful logs
    autoLogging: { ignore: (req) => ['/ping', '/health', '/metrics'].includes(req.url) },
    ...accessLogOptions,
  })
);
app.use(requestMetrics);
watchClickStream(redis);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '300kb' }));

app.use(healthRoutes);
app.use(metricsRoutes);
app.use('/api/v1', rateLimit('apiIp', { scope: 'ip' }));
app.use('/api/v1/keys', keysRoutes);
app.use('/api/v1/links', linksRoutes);
app.use(redirectRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
});

// Express 5 forwards errors from async handlers here automatically
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Bad JSON and oversized bodies are the client's mistake, not ours
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) req.log.error({ err }, 'Unhandled error');

  res.status(status).json({
    error: status === 500 ? 'internal_error' : 'bad_request',
    message: status === 500 ? 'Something went wrong' : err.message,
  });
});

export default app;