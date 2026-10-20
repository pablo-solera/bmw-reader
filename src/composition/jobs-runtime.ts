import { UnrecoverableError, type Job, type Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { resolveModelSeries } from "../model-series.js";
import { baseExtractionDate } from "../domain/labour/validation.js";
import { createRedisTypekeyLocks } from "../infrastructure/redis/typekey-locks.js";
import type { AppConfig } from "../config.js";
import { assertWorkerAlive } from "../worker-lock.js";
import { BmwClient, BmwRequestCancelledError } from "../bmw/client.js";
import { createFetchTypekey, type FetchTypekeyServices } from "../bmw/fetch-typekey.js";
import type { BmwObjectStorage } from "../storage.js";
import type { ExtractionInput, JobState } from "../types.js";
import type { TypekeyProgressStore } from "../typekey-progress.js";
import { recoverCancelledLabourJobs, resumeOrphanedLabourJobs } from "../application/use-cases/recover-labour-jobs.js";
import { enqueueLabourUseCase } from "../application/use-cases/enqueue-labour.js";
import { cancelLabourUseCase } from "../application/use-cases/cancel-labour.js";
import { resumeLabourUseCase } from "../application/use-cases/resume-labour.js";
import { finishLabourUseCase } from "../application/use-cases/finish-labour.js";
import { processLabourTypekeyUseCase } from "../application/use-cases/process-labour-typekey.js";
import { listLaboursUseCase } from "../application/use-cases/list-labours.js";
import { RedisStateStore } from "reader-core/infrastructure/redis/state-store";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import { createBullMqQueue, createBullMqWorker, type BullMqQueueClient } from "reader-core/infrastructure/bullmq/adapter";
import type { LabourInput, LabourListFilters, LabourListItem } from "../domain/labour/types.js";
import { incompleteTypekeysForCleanup, typekeyPathForJob, isBullMqJobPending } from "../domain/labour/policies.js";
import { EXTRACTION_JOB_OPTIONS, EXTRACTION_QUEUE_NAME } from "../application/ports/extraction-queue-policy.js";
import { createExtractionJobId } from "../domain/labour/job-id.js";
import { workerHeartbeatKey, workerLockKey } from "../worker-lock.js";
export type JobsRuntimeDependencies = {
  settings: AppConfig;
  redis: import("ioredis").Redis;
  objectStorage: BmwObjectStorage;
  progressStore: TypekeyProgressStore;
  createBmwClient(language: string, onRateLimitChange?: ConstructorParameters<typeof BmwClient>[2], cancelSignal?: AbortSignal): BmwClient;
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
  close: async () => (await getExtractionQueue()).close(),
};
const bmwKey = createKeyspace("bmw-reader");
const stateKey = (id: string) => bmwKey("job", id);
const labourIndexKey = bmwKey("labours", "index");
const labourIndexReadyKey = bmwKey("labours", "index", "ready");
const labourIndexTtlMs = config.STATE_TTL_SECONDS * 1000;
const stateStore = new RedisStateStore<JobState>(redis, stateKey, config.STATE_TTL_SECONDS);
const typekeyLocks = createRedisTypekeyLocks(redis as unknown as import("../infrastructure/redis/typekey-locks.js").TypekeyLockRedis, config.S3_BUCKET, config.STATE_TTL_SECONDS);
const fetchTypekey = createFetchTypekey({ ...objectStorage, progressStore, settings: config } as FetchTypekeyServices);
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = bmwKey("paused-jobs");
const cancellingJobsKey = bmwKey("cancelling-jobs");
const cancellationKey = (id: string) => bmwKey("job", id, "cancel");
const jobHeartbeatKey = (id: string) => bmwKey("job", id, "heartbeat");
const activeCancellation = new Map<string, AbortController>();
function setWorkerShuttingDown(value: boolean) {
  workerShuttingDown = value;
  if (value) void activeWorker?.pause(true);
}
async function state(id: string): Promise<JobState | null> {
  return stateStore.get(id);
}

async function saveState(value: JobState, index = false) {
  const saved = await stateStore.set(value.requestId, value, value.updatedAt);
  if (index) {
    await indexLabourState(saved);
    await redis.pexpire(labourIndexKey, labourIndexTtlMs);
  }
  return saved;
}
async function updateState(id: string, patch: Partial<JobState>) {
  const deletedKeys = Object.entries(patch).flatMap(([key, value]) => value === undefined ? [key] : []);
  const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<JobState>;
  return stateStore.patch(id, values, deletedKeys);
}

async function indexLabourState(value: JobState) {
  if (value.resource !== "labours") return;
  const score = Date.parse(value.createdAt);
  if (!Number.isFinite(score)) return;
  await redis.zadd(labourIndexKey, score, value.requestId);
}

async function claimTypekeyPaths(requestId: string, input: LabourInput): Promise<string[]> {
  return typekeyLocks.claim(requestId, input);
}

async function releaseTypekeyPaths(requestId: string, paths: string[]) {
  await typekeyLocks.release(requestId, paths);
}

async function renewTypekeyPaths(requestId: string) {
  await typekeyLocks.renew(requestId);
}

async function releaseCompletedTypekeyPath(requestId: string, input: LabourInput, typekey: string) {
  const index = input.typekeys.findIndex(item => item.typekey === typekey);
  if (index < 0) return;
  const path = typekeyPathForJob(input, index);
  if (path) await releaseTypekeyPaths(requestId, [path]);
}

async function ensureLabourIndex() {
  const lockKey = `${labourIndexReadyKey}:lock`;
  const lockToken = randomUUID();
    const acquired = await redis.set(lockKey, lockToken, "PX", 30000, "NX");
  if (acquired !== "OK") {
    if (await redis.exists(labourIndexReadyKey)) {
      await redis.pexpire(labourIndexReadyKey, labourIndexTtlMs);
      return;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await redis.exists(labourIndexReadyKey)) return;
    }
    throw new Error("Timed out waiting for labour request index initialization");
  }
  try {
  if (await redis.exists(labourIndexReadyKey)) {
    await redis.pexpire(labourIndexReadyKey, labourIndexTtlMs);
    return;
  }
   const cutoff = Date.now() - labourIndexTtlMs;
   await redis.zremrangebyscore(labourIndexKey, "-inf", cutoff);
   const indexedIds = await redis.zrangebyscore(labourIndexKey, cutoff, "+inf");
  const states = indexedIds.length ? await redis.mget(...indexedIds.map(stateKey)) : [];
  const missing = indexedIds.filter((_id, index) => states[index] === null);
  if (missing.length) await redis.zrem(labourIndexKey, ...missing);
    await redis.set(labourIndexReadyKey, "1", "PX", labourIndexTtlMs);
   } finally {
     await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
   }
}

async function requestIdsFromIndex(): Promise<string[]> {
  await ensureLabourIndex();
  const cutoff = Date.now() - labourIndexTtlMs;
  await redis.zremrangebyscore(labourIndexKey, "-inf", cutoff);
  const ids = await redis.zrangebyscore(labourIndexKey, cutoff, "+inf");
  if (ids.length) {
    const values = await redis.mget(...ids.map(stateKey));
    const missing = ids.filter((_id, index) => values[index] === null);
    if (missing.length) await redis.zrem(labourIndexKey, ...missing);
  }
  return ids;
}

async function listLabours(filters: LabourListFilters = {}, cursor?: string, count = 50): Promise<{ items: LabourListItem[]; nextCursor: string | null }> {
  const cutoff = Date.now() - labourIndexTtlMs;
  return listLaboursUseCase(filters, cursor, count, {
    ensureIndex: ensureLabourIndex,
    cutoff: () => cutoff,
    pruneExpired: async value => { await redis.zremrangebyscore(labourIndexKey, "-inf", value); },
    fetchRequestIds: async (value, offset, limit) => redis.zrevrangebyscore(labourIndexKey, "+inf", value, "LIMIT", offset, limit),
    fetchStates: async requestIds => {
      if (!requestIds.length) return [];
      const rawStates = await redis.mget(...requestIds.map(stateKey));
      return rawStates.map(raw => raw ? JSON.parse(raw) as JobState : null);
    },
    removeMissing: async ids => { if (ids.length) await redis.zrem(labourIndexKey, ...ids); },
  });
}

async function readyCheck() {
  await assertWorkerAlive(redis);
}

async function cleanupCancelledLabour(requestId: string, input: LabourInput) {
  const cancelKey = cancellationKey(requestId);
  const deleted: Array<{ typekey: string; deletedObjects: number; skipped: boolean }> = [];
  const completedPaths = new Set<string>();
  const markers = await Promise.all(input.typekeys.map((entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path ? objectStorage.getJsonIfExists(`${objectStorage.objectKey(...path.split("/"))}/${entry.typekey}_completed.json`) : Promise.resolve(undefined);
  }));
  for (let index = 0; index < markers.length; index++) {
    const path = typekeyPathForJob(input, index);
    if (path && markers[index]) completedPaths.add(path);
  }
  const ownerSet = bmwKey("active-typekey-owners", requestId);
  const ownedHashes = new Set(await redis.smembers(ownerSet));
  const cleanupTargets = incompleteTypekeysForCleanup(input, completedPaths, new Set());
  try {
    await Promise.all(cleanupTargets.map(async ({ entry, path: relativePath }) => {
      const prefix = objectStorage.objectKey(...relativePath.split("/"));
      try {
        const hash = typekeyLocks.hashPath(relativePath);
        if (!ownedHashes.has(hash) || await objectStorage.getJsonIfExists(`${prefix}/${entry.typekey}_completed.json`)) {
          deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
          return;
        }
        const deletedObjects = await objectStorage.deletePrefix(prefix);
        await progressStore.clear(relativePath);
        deleted.push({ typekey: entry.typekey, deletedObjects, skipped: false });
      } catch (error) {
        console.error(JSON.stringify({ event: "typekey_cleanup_failed", requestId, typekey: entry.typekey, path: relativePath, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    }));
  } finally {
    await redis.del(cancelKey);
    await releaseTypekeyPaths(requestId, cleanupTargets.map(target => target.path));
    for (const target of cleanupTargets) {
      if (deleted.some(result => result.typekey === target.entry.typekey && !result.skipped)) continue;
      await progressStore.recordIncompleteFailure(target.path, `Extraction ${requestId} was cancelled; create a new labour request to retry`);
    }
  }
  for (const entry of input.typekeys) if (!deleted.some(result => result.typekey === entry.typekey)) deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
  return deleted;
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
  const saved = current.input;
  const summary = current.extractionSummary;
  if (!saved || !summary) throw new Error(`Cannot clean cancelled labour ${requestId}: extraction input or summary is missing`);
  const cleanupInput: LabourInput = {
    manufacturer: saved.manufacturer,
    series: saved.series,
    model: saved.model,
    axCode: summary.axCode ?? undefined,
    edition: saved.edition,
    date: summary.date,
    language: saved.language,
    typekeys: summary.typekeys.map(item => ({ typekey: item.typekey, series: item.series, family: item.family, model: item.model })),
  };
    let cleanup: Awaited<ReturnType<typeof cleanupCancelledLabour>> = [];
  let cleanupError: string | undefined;
  try { cleanup = await cleanupCancelledLabour(requestId, cleanupInput); }
  catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
  await updateState(requestId, { status: "cancelled", stage: "cancelled", progress: current.progress, error: cleanupError ? `Cancellation cleanup failed: ${cleanupError}` : undefined });
  await redis.srem(pausedJobsKey, requestId);
  await redis.del(cancellationKey(requestId));
  await redis.srem(cancellingJobsKey, requestId);
  activeCancellation.delete(requestId);
  console.info(JSON.stringify({ event: "extraction_cancelled", requestId, cleanup, cleanupError }));
  return { cleanup, cleanupError };
  } finally {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
  }
}

async function cancelLabour(requestId: string) {
  return cancelLabourUseCase(requestId, {
    getState: state,
    hasCancellation: async id => Boolean(await redis.exists(cancellationKey(id))),
    requestCancellation: async id => {
      await redis.set(cancellationKey(id), "1", "EX", config.STATE_TTL_SECONDS);
      await redis.sadd(cancellingJobsKey, id);
      await redis.expire(cancellingJobsKey, config.STATE_TTL_SECONDS);
    },
    persistCancelling: async value => { await updateState(value.requestId, value); },
    queue: queuePort,
    abortActive: id => activeCancellation.get(id)?.abort(),
    finalize: finalizeCancelledJob,
    log: (event, data) => console.info(JSON.stringify({ event, ...data })),
  });
}

async function queueJob(requestId: string, data: Record<string, unknown>, jobId: string) {
  await extractionQueue.add("extract", { requestId, ...data }, { ...EXTRACTION_JOB_OPTIONS, jobId });
}

const queuePort = {
  add: async (name: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
    const job = await extractionQueue.add(name, data, options);
    return { id: String(job.id ?? options.jobId) };
  },
  getJob: async (id: string) => {
    const job = await extractionQueue.getJob(id);
    return job ? { id: String(job.id), getState: () => job.getState(), remove: () => job.remove() } : null;
  },
};

async function enqueueLabour(input: LabourInput, resumeAt = 0, requestId = randomUUID()) {
  return enqueueLabourUseCase(input, {
    getState: state,
    saveState,
    deleteState: async id => { await redis.del(stateKey(id)); },
    claimTypekeyPaths,
    releaseTypekeyPaths,
    isCancelling: async id => Boolean(await redis.exists(cancellationKey(id))),
    queue: queuePort,
    newId: randomUUID,
    now: () => new Date(),
  }, resumeAt, requestId);
}

async function processLabourTypekey(job: Job) {
  const { requestId, input, index, runId: jobRunId } = job.data as { requestId: string; input: LabourInput; index: number; runId?: string };
  return processTypekeyJob(job, requestId, input, index, jobRunId, Boolean(job.data.replacementAttempt));
}

async function processTypekeyJob(job: Job, requestId: string, input: LabourInput, index: number, jobRunId?: string, replacementAttempt = false) {
  const runId = jobRunId ?? randomUUID();
  const controller = new AbortController();
  const heartbeatKey = jobHeartbeatKey(requestId);
  const heartbeatTimer = setInterval(() => {
    void redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
    void renewTypekeyPaths(requestId).catch(error => console.warn(JSON.stringify({ event: "typekey_lock_renew_failed", requestId, error: error instanceof Error ? error.message : String(error) })));
    void redis.exists(cancellationKey(requestId)).then(exists => { if (exists) controller.abort(); }).catch(error => console.warn(JSON.stringify({ event: "cancel_flag_poll_failed", requestId, error: error instanceof Error ? error.message : String(error) })));
  }, 5000);
  heartbeatTimer.unref?.();
  await redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
  activeCancellation.set(requestId, controller);
  try {
    if (await redis.exists(cancellationKey(requestId))) controller.abort();
    return await processLabourTypekeyUseCase({ attemptsMade: job.attemptsMade, attempts: Number(job.opts.attempts ?? 1), id: job.id ? String(job.id) : undefined }, requestId, input, index, runId, replacementAttempt, {
      async download(labour, labourIndex, id, _runId, forceRestart, onProgress) {
        const entry = labour.typekeys[labourIndex]!;
        const series = resolveModelSeries(entry.series, labour.series);
        const typekeyInput: ExtractionInput = { manufacturer: labour.manufacturer, series, model: entry.model ?? labour.model ?? "", family: entry.family, axCode: labour.axCode, edition: labour.edition ?? labour.date, language: labour.language };
        const client = createBmwClient(labour.language ?? config.BMW_API_LANGUAGE, async event => {
          if (event.recovered) {
            const current = await state(id);
            if (current) await saveState({ ...current, status: "downloading", stage: `${entry.typekey}:resumed`, rateLimitInfo: undefined });
            return;
          }
          const retryAt = new Date(Date.now() + event.cooldownMs).toISOString();
          const current = await state(id);
          if (current) await saveState({ ...current, status: event.cooldownMs > 10000 ? "rate-limited" : current.status, stage: event.cooldownMs > 10000 ? `${entry.typekey}:rate-limited` : current.stage, rateLimitInfo: { count: event.count, cooldownUntil: retryAt, retryAfterMs: event.retryAfterMs } });
        }, controller.signal);
        await updateState(id, { status: "downloading", stage: `${entry.typekey}:preparing` });
        console.info(JSON.stringify({ event: "typekey_started", requestId: id, typekey: entry.typekey, index: labourIndex }));
        return fetchTypekey(client, typekeyInput, entry.typekey, id, baseExtractionDate(labour.date), onProgress, true, () => workerShuttingDown || controller.signal.aborted, forceRestart);
      },
      getState: state,
      updateState,
      finalizeCancellation: finalizeCancelledJob,
      isCancellationRequested: async id => Boolean(await redis.exists(cancellationKey(id))) || controller.signal.aborted,
      isCancelledError: error => error instanceof BmwRequestCancelledError,
      isShuttingDown: () => workerShuttingDown,
      addPaused: async id => { await redis.sadd(pausedJobsKey, id); },
      releaseCompletedPath: releaseCompletedTypekeyPath,
      queueNext: async (_id, labour, nextIndex, activeRunId, nextJobId) => {
        const typekeyPaths = labour.typekeys.map((_entry, typekeyIndex) => typekeyPathForJob(labour, typekeyIndex)).filter((path): path is string => Boolean(path));
        await queueJob(requestId, { input: labour, index: nextIndex, runId: activeRunId, typekeyPaths }, nextJobId);
      },
      finish: finishLabour,
      releasePaths: releaseTypekeyPaths,
      now: Date.now,
      info: (event, data) => console.info(JSON.stringify({ event, ...data })),
      error: (event, data) => console.error(JSON.stringify({ event, ...data })),
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
    releaseTypekeyPaths,
    clearPaused: async id => { await redis.srem(pausedJobsKey, id); },
    now: Date.now,
    info: (event, data) => console.info(JSON.stringify({ event, ...data })),
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
    claimTypekeyPaths,
    releaseTypekeyPaths,
    clearPaused: async id => { await redis.srem(pausedJobsKey, id); },
    newId: randomUUID,
  }, force, startupRecovery);
}

async function resumePausedJobs() {
  return resumeOrphanedLabourJobs({
    getPausedRequestIds: () => redis.smembers(pausedJobsKey),
    getIndexedRequestIds: requestIdsFromIndex,
    getState: state,
    getQueueJobState: async current => {
      const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
      return job ? job.getState() : null;
    },
    resume: requestId => resumeLabour(requestId, false, true),
    warn: (event, requestId, error) => console.warn(JSON.stringify({ event, requestId, error: error instanceof Error ? error.message : String(error) })),
  });
}

async function recoverCancelledLabours() {
  return recoverCancelledLabourJobs({
    getIndexedRequestIds: requestIdsFromIndex,
    getState: state,
    getQueueJobState: async current => {
      const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
      return job ? job.getState() : null;
    },
    finalizeCancellation: finalizeCancelledJob,
  });
}

async function workerLiveness() {
  const [heartbeat, ttl, queueCounts] = await Promise.all([
    redis.get(workerHeartbeatKey), redis.pttl(workerHeartbeatKey),
    extractionQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
  ]);
  return { alive: ttl > 0, concurrency: config.JOB_CONCURRENCY, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: EXTRACTION_QUEUE_NAME, queueCounts };
}

async function isLabourStalled(requestId: string, currentState?: JobState) {
  const current = currentState ?? await state(requestId);
  if (!current || current.status === "cancelled" || current.status === "cancelling" || !["downloading", "queued", "rate-limited"].includes(current.status)) return false;
  if (await redis.pttl(jobHeartbeatKey(requestId)) > 0) return false;
  const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
  if (!job) return true;
  const jobState = await job.getState();
  return !isBullMqJobPending(jobState);
}

return {
  extractionQueue,
  setWorkerShuttingDown,
  state,
  ensureLabourIndex,
  listLabours,
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
