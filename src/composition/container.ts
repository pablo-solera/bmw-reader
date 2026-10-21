import { loadConfig, type AppConfig } from "../config.js";
import { createRedisClient } from "../infrastructure/redis/client.js";
import { createBmwRateLimiter } from "../infrastructure/bmw/rate-limit.js";
import { AccessTokenPool, createAccessTokenProvider, createTokenRequest } from "../infrastructure/bmw/auth.js";
import { BmwClient, BmwRateLimitWaitTimeoutError, type BmwClientOverrides } from "../infrastructure/bmw/client.js";
import { normalizeTypeResearchResponse } from "../infrastructure/bmw/type-research.js";
import type { TypeResearchQuery } from "../application/ports/vehicle-type-research.js";
import { createBmwObjectStorage } from "../infrastructure/s3/object-storage.js";
import { createApp } from "../app.js";
import { createParsedModelOptionsHandler } from "../interfaces/http/model-options-handler.js";
import { toBmwRequestState } from "../interfaces/http/state-mapper.js";
import type { JobState } from "../domain/labour/job-state.js";
import { createJobsRuntime } from "./jobs-runtime.js";
import { downloadLabourArtifactUseCase } from "../application/use-cases/download-labour-artifact.js";
import { buildBmwOpenApi, docsHtml } from "../interfaces/http/openapi.js";
import { RedisTypekeyProgressStore } from "../infrastructure/redis/typekey-progress-store.js";
import { UnavailableError } from "reader-core/domain/errors";

export function createBmwContainer(settings: AppConfig = loadConfig(process.env)) {
  const redis = createRedisClient(settings.REDIS_URL, { maxRetriesPerRequest: null });
  const rateLimiter = createBmwRateLimiter(redis, settings);
  const tokenProvider = createAccessTokenProvider(new AccessTokenPool(settings.BMW_API_TOKEN_POOL_SIZE, createTokenRequest(settings)));
  const objectStorage = createBmwObjectStorage(settings);
  const progressStore = new RedisTypekeyProgressStore(redis, settings.STATE_TTL_SECONDS, settings.S3_BUCKET, settings.BMW_API_LANGUAGE);
  const createBmwClient = (overrides: BmwClientOverrides = {}) => new BmwClient({
    settings,
    language: overrides.language ?? settings.BMW_API_LANGUAGE,
    onRateLimitChange: overrides.onRateLimitChange,
    cancelSignal: overrides.cancelSignal,
    tokenProvider,
    rateLimiter,
  });
  const jobs = createJobsRuntime({ settings, redis, objectStorage, progressStore, createBmwClient });
  const discoverModelOptions = async (query: TypeResearchQuery) => {
      let raw: unknown;
      try {
        raw = await createBmwClient({ language: query.language }).vehicleAttributes(Object.fromEntries(Object.entries({
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
  const app = createApp({
    readyChecks: { redis: () => redis.ping().then(() => undefined), s3: objectStorage.checkBucket, worker: jobs.readyCheck },
    openApi: buildBmwOpenApi(settings.PORT),
    docsHtml,
    modelOptions: createParsedModelOptionsHandler(discoverModelOptions, key => redis.get(key), (key, value, expiry, ttl) => redis.set(key, value, expiry, ttl)),
    createLabour: jobs.enqueueLabour,
    listLabours: jobs.listLabours,
    getState: jobs.state,
    cancelLabour: jobs.cancelLabour,
    resumeLabour: jobs.resumeLabour,
    isLabourStalled: jobs.isLabourStalled,
    downloadArtifact: (requestId, name) => downloadLabourArtifactUseCase(requestId, name, {
      getState: jobs.state,
      getArtifact: objectStorage.getJsonIfExists,
      signDownload: objectStorage.signedDownload,
      objectKey: objectStorage.objectKey,
      bucket: settings.S3_BUCKET,
    }),
    createLabourArchive: jobs.createLabourArchive,
    async mapState(value: JobState) {
      const [worker, stalled] = await Promise.all([jobs.workerLiveness(), jobs.isLabourStalled(value.requestId, value)]);
      return toBmwRequestState(value, objectStorage.objectKey, settings.S3_BUCKET, { worker, stalled });
    },
  });
  return { config: settings, redis, objectStorage, jobs, app, close: async () => { await jobs.extractionQueue.close(); await redis.quit(); } };
}
