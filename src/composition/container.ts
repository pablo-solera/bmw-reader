import { loadConfig, type AppConfig } from "../config.js";
import { createRedisClient } from "../infrastructure/redis/client.js";
import { createBmwRateLimiter } from "../bmw/rate-limit.js";
import { AccessTokenPool, createAccessTokenProvider, createTokenRequest } from "../bmw/auth.js";
import { BmwClient, BmwRateLimitWaitTimeoutError } from "../bmw/client.js";
import { normalizeTypeResearchResponse } from "../bmw/type-research.js";
import type { TypeResearchQuery } from "../application/ports/vehicle-type-research.js";
import { createBmwObjectStorage } from "../infrastructure/s3/object-storage.js";
import { createApiRuntime } from "./api-runtime.js";
import { createJobsRuntime } from "./jobs-runtime.js";
import { buildBmwOpenApi, docsHtml } from "../interfaces/http/openapi.js";
import { RedisTypekeyProgressStore, type TypekeyProgressRedis } from "../infrastructure/redis/typekey-progress-store.js";
import { UnavailableError } from "reader-core/domain/errors";

export function createBmwContainer(settings: AppConfig = loadConfig(process.env)) {
  const redis = createRedisClient(settings.REDIS_URL, { maxRetriesPerRequest: null });
  const rateLimiter = createBmwRateLimiter(redis, settings);
  const tokenProvider = createAccessTokenProvider(new AccessTokenPool(settings.BMW_API_TOKEN_POOL_SIZE, createTokenRequest(settings, process.env)));
  const objectStorage = createBmwObjectStorage(settings);
  const progressStore = new RedisTypekeyProgressStore(redis as unknown as TypekeyProgressRedis, settings.STATE_TTL_SECONDS, settings.S3_BUCKET, settings.BMW_API_LANGUAGE);
  const createBmwClient = (language = settings.BMW_API_LANGUAGE, onRateLimitChange?: ConstructorParameters<typeof BmwClient>[2], cancelSignal?: AbortSignal) => new BmwClient(
    settings,
    language,
    onRateLimitChange,
    cancelSignal,
    tokenProvider,
    rateLimiter,
    process.env,
  );
  const jobs = createJobsRuntime({ settings, redis, objectStorage, progressStore, createBmwClient });
  const discoverModelOptions = async (query: TypeResearchQuery) => {
      let raw: unknown;
      try {
        raw = await createBmwClient(query.language).vehicleAttributes(Object.fromEntries(Object.entries({
          filterByType: query.filterByType,
          filterByBrand: query.brand,
          filterByModelSeries: query.modelSeries,
          filterByDevelopmentCode: query.developmentCode,
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string")), settings.BMW_MODEL_OPTIONS_RATE_LIMIT_WAIT_MS);
      } catch (error) {
        if (error instanceof BmwRateLimitWaitTimeoutError) {
          throw new UnavailableError("BMW model discovery is temporarily rate-limited", { retryAfterMs: error.waitTimeoutMs }, { cause: error });
        }
        throw error;
      }
      const normalized = normalizeTypeResearchResponse(raw);
      return { availableFilters: normalized.availableFilters as Record<string, unknown>, typekeys: normalized.typekeys, raw: normalized.raw };
  };
  const app = createApiRuntime({
    readyChecks: { redis: () => redis.ping().then(() => undefined), s3: objectStorage.checkBucket, worker: jobs.readyCheck },
    openApi: buildBmwOpenApi(settings.PORT),
    docsHtml,
    modelOptionsGet: key => redis.get(key),
    modelOptionsSet: (key, value, expiry, ttl) => redis.set(key, value, expiry, ttl),
    createLabour: jobs.enqueueLabour,
    listLabours: jobs.listLabours,
    getState: jobs.state,
    cancelLabour: jobs.cancelLabour,
    resumeLabour: jobs.resumeLabour,
    isLabourStalled: jobs.isLabourStalled,
    readWorkerLiveness: jobs.workerLiveness,
    getArtifact: objectStorage.getJsonIfExists,
    signDownload: objectStorage.signedDownload,
    objectKey: objectStorage.objectKey,
    bucket: settings.S3_BUCKET,
    discoverModelOptions,
  });
  return { config: settings, redis, objectStorage, jobs, app, close: async () => { await jobs.extractionQueue.close(); await redis.quit(); } };
}
