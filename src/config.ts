import { z } from "zod";

const emptyToUndefined = (value: unknown) => value === "" ? undefined : value;
const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3004),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  STATE_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  JOB_CONCURRENCY: z.coerce.number().int().positive().max(1).default(1),
  BMW_API_ACCESS_TOKEN_URL: z.string().url().default("https://auth.bmwgroup.com/auth/oauth2/machine2machine/access_token"),
  BMW_API_CLIENT_ID: z.string().default(""),
  BMW_API_CLIENT_SECRET: z.string().default(""),
  BMW_API_KEY: z.string().default(""),
  BMW_API_BASE_URL: z.string().url().default("https://apim.bmwgroup.com/aftersales/flatrates/v1"),
  BMW_VEHICLE_ID_BASE_URL: z.string().url().default("https://apim.bmwgroup.com/aftersales/vehicle-identification/type-research/v1"),
  BMW_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  BMW_API_TOKEN_POOL_SIZE: z.coerce.number().int().positive().max(10).default(10),
  BMW_API_LANGUAGE: z.string().default("en-GB"),
  BMW_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().max(20).default(3),
  BMW_RATE_LIMIT_MAX_COOLDOWN_MS: z.coerce.number().int().positive().default(1800000),
  BMW_RATE_LIMIT_MIN_TIME_MS: z.coerce.number().int().nonnegative().default(25),
  BMW_AW_SHEET_CONCURRENCY: z.coerce.number().int().positive().max(20).default(8),
  BMW_5XX_RETRY_WINDOW_MS: z.coerce.number().int().positive().default(600000),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_BUCKET: z.string().default("magnets-reader-dev"),
  S3_PREFIX: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  S3_AUTO_CREATE_BUCKET: z.enum(["true", "false"]).default("false"),
});

export type AppConfig = {
  HOST: string; PORT: number; REDIS_URL: string; STATE_TTL_SECONDS: number; JOB_CONCURRENCY: number;
  BMW_API_ACCESS_TOKEN_URL: string; BMW_API_CLIENT_ID: string; BMW_API_CLIENT_SECRET: string; BMW_API_KEY: string;
  BMW_API_BASE_URL: string; BMW_VEHICLE_ID_BASE_URL: string; BMW_API_TIMEOUT_MS: number; BMW_API_TOKEN_POOL_SIZE: number;
  BMW_API_LANGUAGE: string; BMW_RATE_LIMIT_PER_SEC: number; BMW_RATE_LIMIT_MAX_COOLDOWN_MS: number; BMW_RATE_LIMIT_MIN_TIME_MS: number;
  BMW_AW_SHEET_CONCURRENCY: number; BMW_5XX_RETRY_WINDOW_MS: number; S3_ENDPOINT?: string; S3_REGION: string; S3_ACCESS_KEY: string;
  S3_SECRET_ACCESS_KEY: string; S3_BUCKET: string; S3_PREFIX: string; S3_FORCE_PATH_STYLE: "true" | "false";
  S3_AUTO_CREATE_BUCKET: "true" | "false"; s3ForcePathStyle: boolean; s3AutoCreateBucket: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const raw = envSchema.parse(env);
  return { ...raw, s3ForcePathStyle: raw.S3_FORCE_PATH_STYLE === "true", s3AutoCreateBucket: raw.S3_AUTO_CREATE_BUCKET === "true" };
}

export function requireBmwCredentials(env: NodeJS.ProcessEnv) {
  const clientId = env.BMW_API_CLIENT_ID?.trim();
  const clientSecret = env.BMW_API_CLIENT_SECRET;
  const apiKey = env.BMW_API_KEY?.trim();
  if (!clientId || !clientSecret || !apiKey) throw new Error("BMW_API_CLIENT_ID, BMW_API_CLIENT_SECRET and BMW_API_KEY are required");
  return { clientId, clientSecret, apiKey };
}
