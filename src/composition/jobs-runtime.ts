import { UnrecoverableError, type Job, type Worker } from "bullmq";
import archiver from "archiver";
import { NotFoundError, NotReadyError } from "reader-core/domain/errors";
import { randomUUID } from "node:crypto";
import { resolveModelSeries } from "../domain/labour/series.js";
import { baseExtractionDate } from "../domain/labour/validation.js";
import { createRedisTypekeyLocks } from "../infrastructure/redis/typekey-locks.js";
import { createRedisLabourIndex } from "../infrastructure/redis/labour-index.js";
import type { AppConfig } from "../config.js";
import { assertWorkerAlive, workerHeartbeatKey, workerLockKey } from "../infrastructure/redis/worker-lock.js";
import { BmwClient, BmwRequestCancelledError, type BmwClientOverrides } from "../infrastructure/bmw/client.js";
import { createFetchTypekey } from "../application/use-cases/fetch-typekey.js";
import type { BmwObjectStorage } from "../infrastructure/s3/object-storage.js";
import type { ExtractionInput, JobState } from "../domain/labour/job-state.js";
import type { TypekeyProgressStore } from "../application/ports/typekey-progress-store.js";
import { recoverCancelledLabourJobs, resumeOrphanedLabourJobs } from "../application/use-cases/recover-labour-jobs.js";
import { enqueueLabourUseCase, type EnqueueLabourRequest } from "../application/use-cases/enqueue-labour.js";
import { cancelLabourUseCase } from "../application/use-cases/cancel-labour.js";
import { resumeLabourUseCase } from "../application/use-cases/resume-labour.js";
import { finishLabourUseCase } from "../application/use-cases/finish-labour.js";
import { processLabourTypekeyUseCase } from "../application/use-cases/process-labour-typekey.js";
import { listLaboursUseCase } from "../application/use-cases/list-labours.js";
import { cleanupCancelledLabourUseCase } from "../application/use-cases/cleanup-cancelled-labour.js";
import { finalizeCancelledLabourUseCase } from "../application/use-cases/finalize-cancelled-labour.js";
import { RedisStateStore } from "reader-core/infrastructure/redis/state-store";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import { createBullMqQueue, createBullMqWorker, type BullMqQueueClient } from "reader-core/infrastructure/bullmq/adapter";
import type { Logger } from "reader-core/application/ports/runtime";
import type { LabourInput, LabourListFilters, LabourListItem } from "../domain/labour/types.js";
import { typekeyPathForJob } from "../application/typekey-path.js";
import { isQueueJobPending } from "../application/ports/extraction-queue.js";
import { EXTRACTION_JOB_OPTIONS, EXTRACTION_QUEUE_NAME, toExtractionQueueJobState } from "../infrastructure/bullmq/extraction-policy.js";
import { createExtractionJobId } from "../domain/labour/job-id.js";
export type JobsRuntimeDependencies = {
  settings: AppConfig;
  redis: import("ioredis").Redis;
  objectStorage: BmwObjectStorage;
  progressStore: TypekeyProgressStore;
  createBmwClient(overrides?: BmwClientOverrides): BmwClient;
};

export type JobsRuntime = ReturnType<typeof createJobsRuntime>;

export function createJobsRuntime(dependencies: JobsRuntimeDependencies) {
const { settings: config, redis, objectStorage, progressStore, createBmwClient } = dependencies;
const connection = { connection: redis };
let queuePromise: Promise<BullMqQueueClient<Record<string, unknown>, unknown>> | undefined;
function getExtractionQueue() { return queuePromise ??= createBullMqQueue<Record<string, unknown>, unknown>(EXTRACTION_QUEUE_NAME, connection); }
const extractionQueue = {
  add: async (...args: Parameters<BullMqQueueClient<Record<string, unknown>, unknown>["add"]>) => (await getExtractionQueue()).add(...args),
  getJob: async (...args: Parameters<BullMqQueueClient<Record<string, unknown>, unknown>["getJob"]>) => (await getExtractionQueue()).getJob(...args),
  getJobCounts: async (...args: string[]) => (await getExtractionQueue()).getJobCounts(...args),
  close: async () => { if (queuePromise) await (await queuePromise).close(); },
};
const bmwKey = createKeyspace("bmw-reader");
const stateKey = (id: string) => bmwKey("job", id);
const stateStore = new RedisStateStore<JobState>(redis, stateKey, config.STATE_TTL_SECONDS);
const labourIndex = createRedisLabourIndex(redis, { ttlMs: config.STATE_TTL_SECONDS * 1000, stateKey });
const typekeyLocks = createRedisTypekeyLocks(redis, config.S3_BUCKET, config.STATE_TTL_SECONDS);
const fetchTypekey = createFetchTypekey({ ...objectStorage, progressStore, settings: config });
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = bmwKey("paused-jobs");
const cancellingJobsKey = bmwKey("cancelling-jobs");
const cancellationKey = (id: string) => bmwKey("job", id, "cancel");
const jobHeartbeatKey = (id: string) => bmwKey("job", id, "heartbeat");
const activeCancellation = new Map<string, AbortController>();
const logger: Logger = {
  info: (event: string, data: Record<string, unknown> = {}) => console.info(JSON.stringify({ event, ...data })),
  warn: (event: string, data: Record<string, unknown> = {}) => console.warn(JSON.stringify({ event, ...data })),
  error: (event: string, data: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...data })),
};
const pausedJobs = {
  add: async (id: string) => { await redis.sadd(pausedJobsKey, id); await redis.expire(pausedJobsKey, config.STATE_TTL_SECONDS); },
  remove: async (id: string) => { await redis.srem(pausedJobsKey, id); },
};
const cancellationFlags = {
  isRequested: async (id: string) => Boolean(await redis.exists(cancellationKey(id))),
  request: async (id: string) => {
    await redis.set(cancellationKey(id), "1", "EX", config.STATE_TTL_SECONDS);
    await redis.sadd(cancellingJobsKey, id);
    await redis.expire(cancellingJobsKey, config.STATE_TTL_SECONDS);
  },
  clear: async (id: string) => {
    await redis.del(cancellationKey(id));
    await redis.srem(cancellingJobsKey, id);
    activeCancellation.delete(id);
  },
};
function setWorkerShuttingDown(value: boolean) {
  workerShuttingDown = value;
  if (value) void activeWorker?.pause(true);
}
async function state(id: string): Promise<JobState | null> {
  return stateStore.get(id);
}

async function states(requestIds: string[]): Promise<Array<JobState | null>> {
  if (!requestIds.length) return [];
  const raw = await redis.mget(...requestIds.map(stateKey));
  return raw.map(value => value ? JSON.parse(value) as JobState : null);
}

async function saveState(value: JobState, index = false) {
  const saved = await stateStore.set(value.requestId, value);
  if (index) await labourIndex.add(saved);
  return saved;
}
async function updateState(id: string, patch: Partial<JobState>, ifMatches: Partial<JobState> = {}) {
  const deletedKeys = Object.entries(patch).flatMap(([key, value]) => value === undefined ? [key] : []);
  const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<JobState>;
  return stateStore.patch(id, values, deletedKeys, ifMatches);
}

async function releaseCompletedTypekeyPath(requestId: string, input: LabourInput, typekey: string) {
  const index = input.typekeys.findIndex(item => item.typekey === typekey);
  if (index < 0) return;
  const path = typekeyPathForJob(input, index);
  if (path) await typekeyLocks.release(requestId, [path]);
}

async function listLabours(filters: LabourListFilters = {}, cursor?: string, count = 50): Promise<{ items: LabourListItem[]; nextCursor: string | null }> {
  const cutoff = Date.now() - config.STATE_TTL_SECONDS * 1000;
  return listLaboursUseCase(filters, cursor, count, {
    ensureIndex: labourIndex.ensure,
    cutoff: () => cutoff,
    pruneExpired: value => labourIndex.pruneExpired(value),
    fetchRequestIds: (value, after, limit) => labourIndex.fetchRequestIds(value, after, limit),
    fetchStates: async requestIds => {
      return states(requestIds);
    },
    removeMissing: ids => labourIndex.remove(ids),
  });
}

async function createLabourArchive(requestId: string) {
  const current = await state(requestId);
  if (!current || current.resource !== "labours" || !current.input || !current.extractionSummary) {
    throw new NotFoundError("Completed labour extraction not found", { requestId });
  }
  if (current.status !== "completed") throw new NotReadyError("Labour extraction archive is not ready", { requestId, status: current.status });

  const labourInput: LabourInput = {
    ...current.input,
    date: current.extractionSummary.date,
    typekeys: current.extractionSummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) })),
  };
  const keys = new Set<string>();
  for (let index = 0; index < current.extractionSummary.typekeys.length; index++) {
    const path = typekeyPathForJob(labourInput, index);
    if (!path) continue;
    for (const key of await objectStorage.listObjects(objectStorage.objectKey(...path.split("/")))) keys.add(key);
  }
  if (keys.size === 0) throw new NotReadyError("Labour extraction has no downloadable artifacts", { requestId });

  const archive = archiver("zip", { zlib: { level: 6 } });
  const entries = [...keys].sort();
  let index = 0;
  const prefix = config.S3_PREFIX.replace(/^\/+|\/+$/g, "");
  const appendNext = () => {
    let key = entries[index++];
    while (key) {
      const relativeName = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
      if (!relativeName.startsWith("/") && !relativeName.split(/[\\/]/).includes("..")) break;
      key = entries[index++];
    }
    if (!key) {
      void archive.finalize().catch(error => archive.destroy(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    void objectStorage.getObjectStream(key).then(source => {
      const name = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
      archive.append(source, { name }, error => error ? archive.destroy(error) : appendNext());
    }).catch(error => archive.destroy(error instanceof Error ? error : new Error(String(error))));
  };
  return { stream: archive, start: appendNext };
}

async function readyCheck() {
  await assertWorkerAlive(redis);
}

async function cleanupCancelledLabour(requestId: string, input: LabourInput) {
  try {
    return await cleanupCancelledLabourUseCase(requestId, input, {
      hasCompletionMarker: async (path, typekey) => {
        const prefix = objectStorage.objectKey(...path.split("/"));
        return Boolean(await objectStorage.getJsonIfExists(`${prefix}/${typekey}_completed.json`));
      },
      getOwnedLockHashes: async id => new Set(await redis.smembers(bmwKey("active-typekey-owners", id))),
      isOwnedPath: (path, hashes) => hashes.has(typekeyLocks.hashPath(path)),
      deletePrefix: path => objectStorage.deletePrefix(objectStorage.objectKey(...path.split("/"))),
      clearProgress: path => progressStore.clear(path),
      releasePaths: typekeyLocks.release,
      recordIncompleteFailure: (path, message) => progressStore.recordIncompleteFailure(path, message),
      warn: (event, details) => logger.error(event, details),
    });
  } finally {
    await redis.del(cancellationKey(requestId));
  }
}

async function finalizeCancelledJob(requestId: string, current: JobState) {
  const lockKey = bmwKey("job", requestId, "cancel-cleanup-lock");
  const lockToken = randomUUID();
  if (await redis.set(lockKey, lockToken, "PX", 15 * 60 * 1000, "NX") !== "OK") {
    for (let attempt = 0; attempt < 100; attempt++) {
      const latest = await state(requestId);
      if (latest?.status === "cancelled") return { cleanup: [], cleanupError: latest.error };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for cancellation cleanup for ${requestId}`);
  }
  try {
    return await finalizeCancelledLabourUseCase(requestId, current, {
      updateState,
      cleanup: cleanupCancelledLabour,
      clearPaused: pausedJobs.remove,
      clearCancellationState: cancellationFlags.clear,
      log: logger.info,
    });
  } finally {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
  }
}

async function cancelLabour(requestId: string) {
  return cancelLabourUseCase(requestId, {
    getState: state,
    hasCancellation: cancellationFlags.isRequested,
    requestCancellation: cancellationFlags.request,
    persistCancelling: async value => { await updateState(value.requestId, { status: "cancelling", stage: "cancelling" }, { status: value.status }); },
    queue: queuePort,
    abortActive: id => activeCancellation.get(id)?.abort(),
    finalize: async (id, current) => {
      queueMicrotask(() => {
        void finalizeCancelledJob(id, current).catch(error => logger.error("cancellation_finalize_failed", {
          requestId: id,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      return { cleanup: [], pending: true };
    },
    log: logger.info,
  });
}

const queuePort = {
  enqueue: async (data: Record<string, unknown>, jobId: string) => {
    const job = await extractionQueue.add("extract", data, { ...EXTRACTION_JOB_OPTIONS, jobId });
    return { id: String(job.id ?? jobId) };
  },
  getJob: async (id: string) => {
    const job = await extractionQueue.getJob(id);
    return job ? { id: String(job.id), getState: async () => toExtractionQueueJobState(await job.getState()), remove: () => job.remove() } : null;
  },
};

async function enqueueLabour(input: EnqueueLabourRequest, resumeAt = 0, requestId = randomUUID()) {
  return enqueueLabourUseCase(input, {
    getState: state,
    saveState,
    deleteState: async id => {
      await redis.del(stateKey(id));
      await labourIndex.remove([id]);
    },
    claimTypekeyPaths: typekeyLocks.claim,
    releaseTypekeyPaths: typekeyLocks.release,
    isCancelling: cancellationFlags.isRequested,
    queue: queuePort,
    newId: randomUUID,
    now: () => new Date(),
  }, resumeAt, requestId);
}

async function processLabourTypekey(job: Job) {
  const { requestId, input, index, runId: jobRunId } = job.data as { requestId: string; input: LabourInput; index: number; runId?: string };
  const replacementAttempt = Boolean(job.data.replacementAttempt);
  const runId = jobRunId ?? randomUUID();
  const controller = new AbortController();
  const heartbeatKey = jobHeartbeatKey(requestId);
  const heartbeatTimer = setInterval(() => {
    void redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
    void typekeyLocks.renew(requestId).catch(error => logger.warn("typekey_lock_renew_failed", { requestId, error: error instanceof Error ? error.message : String(error) }));
    void cancellationFlags.isRequested(requestId).then(requested => { if (requested) controller.abort(); }).catch(error => logger.warn("cancel_flag_poll_failed", { requestId, error: error instanceof Error ? error.message : String(error) }));
  }, 5000);
  heartbeatTimer.unref?.();
  await redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
  activeCancellation.set(requestId, controller);
  try {
    if (await cancellationFlags.isRequested(requestId)) controller.abort();
    return await processLabourTypekeyUseCase({ attemptsMade: job.attemptsMade, attempts: Number(job.opts.attempts ?? 1), id: job.id ? String(job.id) : undefined }, requestId, input, index, runId, replacementAttempt, {
      async download(labour, labourIndex, id, _runId, forceRestart, onProgress) {
        const entry = labour.typekeys[labourIndex]!;
        const series = resolveModelSeries(entry.series, labour.series);
        const typekeyInput: ExtractionInput = { manufacturer: labour.manufacturer, series, model: entry.model ?? labour.model ?? "", family: entry.family, axCode: labour.axCode, edition: labour.edition ?? labour.date, language: labour.language };
        const client = createBmwClient({ language: labour.language ?? config.BMW_API_LANGUAGE, onRateLimitChange: async event => {
          if (event.recovered) {
            const current = await state(id);
            if (current && (current.status === "downloading" || current.status === "rate-limited")) {
              await updateState(id, {
                ...(current.status === "rate-limited" ? { status: "downloading", stage: `${entry.typekey}:resumed` } : {}),
                rateLimitInfo: undefined,
              }, { status: current.status });
            }
            return;
          }
          const retryAt = new Date(Date.now() + event.cooldownMs).toISOString();
          const current = await state(id);
          if (current && (current.status === "downloading" || current.status === "rate-limited")) {
            await updateState(id, {
              rateLimitInfo: { count: event.count, cooldownUntil: retryAt, retryAfterMs: event.retryAfterMs },
              ...(event.cooldownMs > 10000 ? { status: "rate-limited", stage: `${entry.typekey}:rate-limited` } : {}),
            }, { status: current.status });
          }
        }, cancelSignal: controller.signal });
        await updateState(id, { status: "downloading", stage: `${entry.typekey}:preparing` });
        logger.info("typekey_started", { requestId: id, typekey: entry.typekey, index: labourIndex });
        return fetchTypekey({
          client,
          input: typekeyInput,
          typekey: entry.typekey,
          requestId: id,
          date: baseExtractionDate(labour.date),
          onProgress,
          resume: true,
          shouldStop: () => workerShuttingDown || controller.signal.aborted,
          forceRestart,
        });
      },
      state: { get: state, update: updateState, finish: finishLabour },
      cancellation: {
        finalize: finalizeCancelledJob,
        isRequested: async id => cancellationFlags.isRequested(id) || controller.signal.aborted,
        isCancelledError: error => error instanceof BmwRequestCancelledError,
      },
      worker: { isShuttingDown: () => workerShuttingDown, addPaused: pausedJobs.add, now: Date.now },
      typekeyLocks: { releaseCompletedPath: releaseCompletedTypekeyPath, releasePaths: typekeyLocks.release },
      queue: { next: async (_id, labour, nextIndex, activeRunId, nextJobId) => {
        const typekeyPaths = labour.typekeys.map((_entry, typekeyIndex) => typekeyPathForJob(labour, typekeyIndex)).filter((path): path is string => Boolean(path));
        await queuePort.enqueue({ requestId, input: labour, index: nextIndex, runId: activeRunId, typekeyPaths }, nextJobId);
      } },
      logger,
      makeUnrecoverable: (message, cause) => {
        const error = new UnrecoverableError(message);
        if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true });
        return error;
      },
    });
  } finally {
    clearInterval(heartbeatTimer);
    if (activeCancellation.get(requestId) === controller) activeCancellation.delete(requestId);
    const heartbeat = await redis.get(heartbeatKey);
    if (heartbeat && JSON.parse(heartbeat).runId === runId) await redis.del(heartbeatKey);
  }
}

async function finishLabour(requestId: string, input: LabourInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  return finishLabourUseCase(requestId, input, summaries, {
    getState: state,
    updateState,
    releaseTypekeyPaths: typekeyLocks.release,
    clearPaused: pausedJobs.remove,
    now: Date.now,
    info: logger.info,
  });
}

async function createExtractionWorker() {
  activeWorker = await createBullMqWorker(EXTRACTION_QUEUE_NAME, processLabourTypekey, {
    ...connection, concurrency: config.JOB_CONCURRENCY, stalledInterval: 15000, lockDuration: 60000, maxStalledCount: 100,
  });
  return activeWorker;
}

async function resumeLabour(requestId: string, force = false, startupRecovery = false) {
  return resumeLabourUseCase(requestId, {
    getState: state,
    updateState,
    getHeartbeatTtl: id => redis.pttl(jobHeartbeatKey(id)),
    workerIsActive: async () => Boolean(await redis.get(workerLockKey)),
    workerShuttingDown: () => workerShuttingDown,
    queue: queuePort,
    queueName: EXTRACTION_QUEUE_NAME,
    claimTypekeyPaths: typekeyLocks.claim,
    releaseTypekeyPaths: typekeyLocks.release,
    clearPaused: pausedJobs.remove,
    newId: randomUUID,
  }, force, startupRecovery);
}

async function resumePausedJobs() {
  return resumeOrphanedLabourJobs({
    getPausedRequestIds: () => redis.smembers(pausedJobsKey),
    getIndexedRequestIds: () => labourIndex.requestIds(),
    getStates: states,
    getQueueJobState: async current => {
      const job = current.bullJobId ? await queuePort.getJob(current.bullJobId) : null;
      return job ? job.getState() : null;
    },
    resume: requestId => resumeLabour(requestId, false, true),
    warn: (event, requestId, error) => logger.warn(event, { requestId, error: error instanceof Error ? error.message : String(error) }),
  });
}

async function recoverCancelledLabours() {
  return recoverCancelledLabourJobs({
    getIndexedRequestIds: () => labourIndex.requestIds(),
    getStates: states,
    getQueueJobState: async current => {
      const job = current.bullJobId ? await queuePort.getJob(current.bullJobId) : null;
      return job ? job.getState() : null;
    },
    finalizeCancellation: finalizeCancelledJob,
  });
}

let workerLivenessCache: { expiresAt: number; value: Awaited<ReturnType<typeof readWorkerLiveness>> } | undefined;
let workerLivenessInFlight: Promise<Awaited<ReturnType<typeof readWorkerLiveness>>> | undefined;
async function readWorkerLiveness() {
  const [heartbeat, ttl, queueCounts] = await Promise.all([
    redis.get(workerHeartbeatKey), redis.pttl(workerHeartbeatKey),
    extractionQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
  ]);
  return { alive: ttl > 0, concurrency: config.JOB_CONCURRENCY, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: EXTRACTION_QUEUE_NAME, queueCounts };
}

async function workerLiveness() {
  if (workerLivenessCache && workerLivenessCache.expiresAt > Date.now()) return workerLivenessCache.value;
  if (workerLivenessInFlight) return workerLivenessInFlight;
  const request = readWorkerLiveness();
  workerLivenessInFlight = request;
  try {
    const value = await request;
    workerLivenessCache = { value, expiresAt: Date.now() + 1000 };
    return value;
  } finally {
    if (workerLivenessInFlight === request) workerLivenessInFlight = undefined;
  }
}

async function isLabourStalled(requestId: string, currentState?: JobState) {
  const current = currentState ?? await state(requestId);
  if (!current || current.status === "cancelled" || current.status === "cancelling" || !["downloading", "queued", "rate-limited"].includes(current.status)) return false;
  if (await redis.pttl(jobHeartbeatKey(requestId)) > 0) return false;
  const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
  if (!job) return true;
  const jobState = await job.getState();
  return !isQueueJobPending(toExtractionQueueJobState(jobState));
}

return {
  extractionQueue,
  setWorkerShuttingDown,
  state,
  ensureLabourIndex: labourIndex.ensure,
  listLabours,
  createLabourArchive,
  readyCheck,
  cancelLabour,
  enqueueLabour,
  createExtractionWorker,
  resumeLabour,
  resumePausedJobs,
  recoverCancelledLabours,
  workerLiveness,
  isLabourStalled,
};
}
