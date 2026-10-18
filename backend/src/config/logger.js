import pino from 'pino';
import env from './env.js';

// Structured JSON logs in production, so a log service can search and filter them.
// Readable, colored output in development. Silent in tests, to keep the output clean.
const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  // Secrets must never end up in logs
  redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
  ...(env.nodeEnv === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    },
  }),
});

export default logger;