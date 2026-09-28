import { z } from "zod";

const emptyToUndefined = (value: unknown) => value === "" ? undefined : value;
const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3004),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  STATE_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(1),
  BMW_API_ACCESS_TOKEN_URL: z.string().url().default("https://auth.bmwgroup.com/auth/oauth2/machine2machine/access_token"),
  BMW_API_TOKEN_INFO_URL: z.string().url().default("https://auth.bmwgroup.com/auth/oauth2/tokeninfo"),
  BMW_API_CLIENT_ID: z.string().default(""),
  BMW_API_CLIENT_SECRET: z.string().default(""),
  BMW_API_KEY: z.string().default(""),
  BMW_API_BASE_URL: z.string().url().default("https://apim.bmwgroup.com/aftersales/flatrates/v1"),
  BMW_VEHICLE_ID_BASE_URL: z.string().url().default("https://apim.bmwgroup.com/aftersales/vehicle-identification/type-research/v1"),
  BMW_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  BMW_API_TOKEN_POOL_SIZE: z.coerce.number().int().positive().max(10).default(10),
  BMW_API_LANGUAGE: z.string().default("en-GB"),
  BMW_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().max(3).default(3),
  BMW_RATE_LIMIT_MAX_COOLDOWN_MS: z.coerce.number().int().positive().default(1800000),
  BMW_RATE_LIMIT_MIN_TIME_MS: z.coerce.number().int().nonnegative().default(25),
  BMW_RATE_LIMIT_STATE_THRESHOLD_MS: z.coerce.number().int().positive().default(10000),
  BMW_AW_SHEET_CHUNK_SIZE: z.coerce.number().int().positive().max(250).default(25),
  BMW_AW_SHEET_CONCURRENCY: z.coerce.number().int().positive().max(3).default(3),
  BMW_MAX_RETRIES: z.coerce.number().int().nonnegative().max(10).default(5),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_BUCKET: z.string().default("magnets-reader-dev"),
  S3_PREFIX: z.string().default("BMW_GROUP/files_datasource/Labour_Time"),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  S3_AUTO_CREATE_BUCKET: z.enum(["true", "false"]).default("false"),
  S3_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BMW_SQL_SERVER: z.string().default(""),
  BMW_SQL_DATABASE: z.string().default("BMW_Labour"),
  BMW_SQL_DATAREQUEST_DATABASE: z.string().default("DataRequestBMW"),
  BMW_SQL_USER: z.string().default(""),
  BMW_SQL_PASSWORD: z.string().default(""),
  BMW_SQL_PORT: z.coerce.number().int().positive().default(1433),
  BMW_SQL_ENCRYPT: z.enum(["true", "false"]).default("true"),
  BMW_SQL_TRUST_SERVER_CERTIFICATE: z.enum(["true", "false"]).default("false"),
  BMW_SQL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BMW_SQL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  BMW_SQL_ALLOWED_DATABASES: z.string().default("BMW_Labour,DataRequestBMW"),
  BMW_CONFIRM_PRODUCTION: z.enum(["true", "false"]).default("false"),
  BMW_SQL_SCHEMA_VERIFIED: z.enum(["true", "false"]).default("false"),
  BMW_CARGA_INICIAL_ROOT: z.string().default(""),
});

const raw = envSchema.parse(process.env);
export const config = {
  ...raw,
  port: raw.PORT,
  allowedDatabases: raw.BMW_SQL_ALLOWED_DATABASES.split(",").map(x => x.trim()).filter(Boolean),
  s3ForcePathStyle: raw.S3_FORCE_PATH_STYLE === "true",
  s3AutoCreateBucket: raw.S3_AUTO_CREATE_BUCKET === "true",
  confirmProduction: raw.BMW_CONFIRM_PRODUCTION === "true",
  sqlSchemaVerified: raw.BMW_SQL_SCHEMA_VERIFIED === "true",
} as const;
export type AppConfig = typeof config;

export function requireBmwCredentials(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.BMW_API_CLIENT_ID?.trim();
  const clientSecret = env.BMW_API_CLIENT_SECRET;
  const apiKey = env.BMW_API_KEY?.trim();
  if (!clientId || !clientSecret || !apiKey) throw new Error("BMW_API_CLIENT_ID, BMW_API_CLIENT_SECRET and BMW_API_KEY are required");
  return { clientId, clientSecret, apiKey };
}
