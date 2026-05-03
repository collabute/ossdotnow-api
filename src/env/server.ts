import { z } from 'zod/v4';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .startsWith('postgresql://')
    .default('postgresql://postgres:postgres@localhost:5432/ossdotnow_db'),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,https://oss.now'),
  AUTH_COOKIE_DOMAIN: z.string().default('oss.now'),
  BETTER_AUTH_SECRET: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  AUTH_EMAIL_FROM: z.string().default(''),
  AUTH_EMAIL_REPLY_TO: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  UNKEY_ROOT_KEY: z.string().default(''),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  UPLOADTHING_TOKEN: z.string().default(''),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
