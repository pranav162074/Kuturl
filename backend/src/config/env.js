import 'dotenv/config';
import { z } from 'zod';

// Everything the app needs is validated once, at startup. A missing or malformed value
// stops the process with a clear message, instead of failing mysteriously later.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // The public address short links are built on, for example https://kuturl.onrender.com
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

const values = parsed.data;

export default {
  nodeEnv: values.NODE_ENV,
  isProduction: values.NODE_ENV === 'production',
  isTest: values.NODE_ENV === 'test',
  port: values.PORT,
  logLevel: values.LOG_LEVEL,
  baseUrl: values.PUBLIC_URL.replace(/\/+$/, ''), // no trailing slash
  databaseUrl: values.DATABASE_URL,
  redisUrl: values.REDIS_URL,
};