import { config, type AppConfig } from "../config.js";
import { createRedisClient } from "../redis.js";
import { createBmwRateLimiter } from "../bmw/rate-limit.js";
import { AccessTokenPool, createAccessTokenProvider } from "../bmw/auth.js";
import { BmwClient } from "../bmw/client.js";
import { createBmwObjectStorage } from "../storage.js";
import { createApiRuntime } from "./api-runtime.js";
import { readyCheck, enqueueLabour, listLabours, state, cancelLabour, resumeLabour, isLabourStalled, workerLiveness } from "../jobs.js";
import { buildBmwOpenApi, docsHtml } from "../interfaces/http/openapi.js";

export function createBmwContainer(settings: AppConfig = config) {
  const redis = createRedisClient(settings.REDIS_URL, { maxRetriesPerRequest: null });
  const rateLimiter = createBmwRateLimiter(redis, settings);
  const tokenProvider = createAccessTokenProvider(new AccessTokenPool(settings.BMW_API_TOKEN_POOL_SIZE));
  const objectStorage = createBmwObjectStorage(settings);
  const createBmwClient = (language = settings.BMW_API_LANGUAGE, onRateLimitChange?: ConstructorParameters<typeof BmwClient>[1], cancelSignal?: AbortSignal) => new BmwClient(
    language,
    onRateLimitChange,
    cancelSignal,
    tokenProvider,
    { acquire: signal => rateLimiter.acquire(signal), report429: (retryAfter, headers) => rateLimiter.report429(retryAfter, headers) },
  );
  const discoverModelOptions = async (query: import("../bmw/type-research.js").TypeResearchQuery) => {
      const client = createBmwClient(query.language);
      const raw = await client.vehicleAttributes(Object.fromEntries(Object.entries({
        filterByType: query.filterByType,
        filterByBrand: query.brand,
        filterByModelSeries: query.modelSeries,
        filterByDevelopmentCode: query.developmentCode,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
      const normalized = (await import("../bmw/type-research.js")).normalizeTypeResearchResponse(raw);
      return { availableFilters: normalized.availableFilters as Record<string, unknown>, typekeys: normalized.typekeys, raw: normalized.raw };
  };
  const app = createApiRuntime({
    readyChecks: { redis: () => redis.ping().then(() => undefined), s3: objectStorage.checkBucket, worker: readyCheck },
    openApi: buildBmwOpenApi(settings.PORT),
    docsHtml,
    port: settings.PORT,
    modelOptionsGet: key => redis.get(key),
    modelOptionsSet: (key, value, expiry, ttl) => redis.set(key, value, expiry, ttl),
    createLabour: enqueueLabour,
    listLabours,
    getState: state,
    cancelLabour,
    resumeLabour,
    isLabourStalled,
    readWorkerLiveness: workerLiveness,
    getArtifact: objectStorage.getJsonIfExists,
    signDownload: objectStorage.signedDownload,
    objectKey: objectStorage.objectKey,
    bucket: settings.S3_BUCKET,
    discoverModelOptions,
  });
  return { config: settings, redis, rateLimiter, tokenProvider, objectStorage, createBmwClient, app, close: () => redis.quit() };
}
