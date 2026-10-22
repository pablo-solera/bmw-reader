import type { Worker } from "bullmq";
import { NotFoundError, NotReadyError } from "reader-core/domain/errors";
import { randomUUID } from "node:crypto";
import { createRedisTypekeyLocks } from "../infrastructure/redis/typekey-locks.js";
import { createRedisLabourStateStore } from "../infrastructure/redis/labour-state-store.js";
import { createLabourRuntimeState } from "../infrastructure/redis/labour-runtime-state.js";
import type { AppConfig } from "../config.js";
import { assertWorkerAlive, workerHeartbeatKey, workerLockKey } from "../infrastructure/redis/worker-lock.js";
import type { BmwClient, BmwClientOverrides } from "../infrastructure/bmw/client.js";
import { createFetchTypekey } from "../application/use-cases/fetch-typekey.js";
import type { BmwObjectStorage } from "../infrastructure/s3/object-storage.js";
import type { LabourState } from "../domain/labour/labour-state.js";
import type { TypekeyProgressStore } from "../application/ports/typekey-progress-store.js";
import { recoverCancelledLabourJobs, resumeOrphanedLabourJobs } from "../application/use-cases/recover-labour-jobs.js";
import { enqueueLabourUseCase, type EnqueueLabourRequest } from "../application/use-cases/enqueue-labour.js";
import { cancelLabourUseCase } from "../application/use-cases/cancel-labour.js";
import { resumeLabourUseCase } from "../application/use-cases/resume-labour.js";
import { finishLabourUseCase } from "../application/use-cases/finish-labour.js";
import { listLaboursUseCase } from "../application/use-cases/list-labours.js";
import { cleanupCancelledLabourUseCase } from "../application/use-cases/cleanup-cancelled-labour.js";
import { finalizeCancelledLabourUseCase } from "../application/use-cases/finalize-cancelled-labour.js";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import { createBullMqWorker } from "reader-core/infrastructure/bullmq/adapter";
import type { Logger } from "reader-core/application/ports/runtime";
import type { LabourInput, LabourListFilters, LabourListItem } from "../domain/labour/types.js";
import { typekeyPathForJob } from "../application/typekey-path.js";
import { createLabourArchiveStream } from "../infrastructure/s3/labour-archive.js";
import { isQueueJobPending } from "../application/ports/labour-queue.js";
import { LABOUR_QUEUE_NAME } from "../infrastructure/bullmq/labour-queue-policy.js";
import { createBullMqLabourQueue } from "../infrastructure/bullmq/labour-queue.js";
import { createLabourTypekeyJobId } from "../domain/labour/labour-job-id.js";
import { createLabourTypekeyProcessor } from "./labour-typekey-processor.js";
import type { TypekeyAvailabilityService } from "./typekey-availability.js";
export type JobsRuntimeDependencies = {
  settings: AppConfig;
  redis: import("ioredis").Redis;
  objectStorage: BmwObjectStorage;
  progressStore: TypekeyProgressStore;
  createBmwClient(overrides?: BmwClientOverrides): BmwClient;
  availability: TypekeyAvailabilityService;
};

export type JobsRuntime = ReturnType<typeof createJobsRuntime>;

export function createJobsRuntime(dependencies: JobsRuntimeDependencies) {
const { settings: config, redis, objectStorage, progressStore, createBmwClient, availability } = dependencies;
const connection = { connection: redis };
const { client: labourQueue, port: queuePort } = createBullMqLabourQueue(redis);
const bmwKey = createKeyspace("bmw-reader");
const labourStore = createRedisLabourStateStore(redis, config.STATE_TTL_SECONDS);
const labourIndex = labourStore.index;
const typekeyLocks = createRedisTypekeyLocks(redis, config.S3_BUCKET, config.STATE_TTL_SECONDS);
const fetchTypekey = createFetchTypekey({ ...objectStorage, progressStore, settings: config });
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const activeCancellation = new Map<string, AbortController>();
const { pausedJobs, cancellationFlags, heartbeatKey: jobHeartbeatKey, cancellationKey } = createLabourRuntimeState(redis, config.STATE_TTL_SECONDS, activeCancellation);
const logger: Logger = {
  info: (event: string, data: Record<string, unknown> = {}) => console.info(JSON.stringify({ event, ...data })),
  warn: (event: string, data: Record<string, unknown> = {}) => console.warn(JSON.stringify({ event, ...data })),
  error: (event: string, data: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...data })),
};
function setWorkerShuttingDown(value: boolean) {
  workerShuttingDown = value;
  if (value) void activeWorker?.pause(true);
}
async function state(id: string): Promise<LabourState | null> {
  return labourStore.get(id);
}

async function states(requestIds: string[]): Promise<Array<LabourState | null>> {
  return labourStore.getMany(requestIds);
}

async function saveState(value: LabourState, index = false) {
  return labourStore.save(value, index);
}
async function updateState(id: string, patch: Partial<LabourState>, ifMatches: Partial<LabourState> = {}) {
  return labourStore.update(id, patch, ifMatches);
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
  if (!current || !current.input || !current.typekeySummary) {
    throw new NotFoundError("Completed labour extraction not found", { requestId });
  }
  if (current.status !== "completed") throw new NotReadyError("Labour extraction archive is not ready", { requestId, status: current.status });

  const labourInput: LabourInput = {
    ...current.input,
    date: current.typekeySummary.date,
    typekeys: current.typekeySummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) })),
  };
  const paths = current.typekeySummary.typekeys.flatMap((_entry, index) => {
    const path = typekeyPathForJob(labourInput, index);
    return path ? [objectStorage.objectKey(...path.split("/"))] : [];
  });
  const archive = await createLabourArchiveStream(objectStorage, paths, config.S3_PREFIX);
  if (!archive) throw new NotReadyError("Labour extraction has no downloadable artifacts", { requestId });
  return archive;
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
      getOwnedLockHashes: async id => new Set(await redis.smembers(bmwKey("typekey-lock-owners", id))),
      isOwnedPath: (path, hashes) => hashes.has(typekeyLocks.hashPath(path)),
      deletePrefix: path => objectStorage.deletePrefix(objectStorage.objectKey(...path.split("/"))),
      clearProgress: path => progressStore.clear(path),
      releasePaths: typekeyLocks.release,
      recordIncompleteFailure: (path, id, message) => progressStore.recordIncompleteFailure(path, id, message),
      warn: (event, details) => logger.error(event, details),
    });
  } finally {
    await redis.del(cancellationKey(requestId));
  }
}

async function finalizeCancelledJob(requestId: string, current: LabourState) {
  const lockKey = bmwKey("labour", requestId, "cancel-cleanup-lock");
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

async function enqueueLabour(input: EnqueueLabourRequest, resumeAt = 0, requestId = randomUUID()) {
  return enqueueLabourUseCase(input, {
    getState: state,
    saveState,
    deleteState: labourStore.delete,
    claimTypekeyPaths: typekeyLocks.claim,
    releaseTypekeyPaths: typekeyLocks.release,
    isCancelling: cancellationFlags.isRequested,
    queue: queuePort,
    assertTypekeysAvailable: availability.assertAvailable,
    newId: randomUUID,
    now: () => new Date(),
  }, resumeAt, requestId);
}

async function finishLabour(requestId: string, input: LabourInput, summaries: NonNullable<LabourState["typekeySummary"]>["typekeys"]) {
  return finishLabourUseCase(requestId, input, summaries, {
    getState: state,
    updateState,
    releaseTypekeyPaths: typekeyLocks.release,
    clearPaused: pausedJobs.remove,
    now: Date.now,
    info: logger.info,
  });
}

const processLabourTypekey = createLabourTypekeyProcessor({
  redis,
  config,
  createBmwClient,
  catalogCache: availability.cache,
  fetchTypekey,
  state,
  updateState,
  finishLabour,
  finalizeCancelledJob,
  typekeyLocks,
  releaseCompletedTypekeyPath,
  cancellationFlags,
  activeCancellation,
  isWorkerShuttingDown: () => workerShuttingDown,
  addPaused: pausedJobs.add,
  queue: queuePort,
  logger,
});

async function createLabourWorker() {
  activeWorker = await createBullMqWorker(LABOUR_QUEUE_NAME, processLabourTypekey, {
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
    queueName: LABOUR_QUEUE_NAME,
    claimTypekeyPaths: typekeyLocks.claim,
    releaseTypekeyPaths: typekeyLocks.release,
    clearPaused: pausedJobs.remove,
    newId: randomUUID,
  }, force, startupRecovery);
}

async function resumePausedJobs() {
  return resumeOrphanedLabourJobs({
    getPausedRequestIds: pausedJobs.list,
    getIndexedRequestIds: () => labourIndex.requestIds(),
    getStates: states,
    getQueueLabourState: async current => {
      const job = current.queueJobId ? await queuePort.getJob(current.queueJobId) : null;
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
    getQueueLabourState: async current => {
      const job = current.queueJobId ? await queuePort.getJob(current.queueJobId) : null;
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
    labourQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
  ]);
  return { alive: ttl > 0, concurrency: config.JOB_CONCURRENCY, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: LABOUR_QUEUE_NAME, queueCounts };
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

async function isLabourStalled(requestId: string, currentState?: LabourState) {
  const current = currentState ?? await state(requestId);
  if (!current || current.status === "cancelled" || current.status === "cancelling" || !["running", "queued", "rate_limited"].includes(current.status)) return false;
  if (await redis.pttl(jobHeartbeatKey(requestId)) > 0) return false;
  const job = current.queueJobId ? await queuePort.getJob(current.queueJobId) : null;
  if (!job) return true;
  return !isQueueJobPending(await job.getState());
}

return {
  labourQueue,
  setWorkerShuttingDown,
  state,
  ensureLabourIndex: labourIndex.ensure,
  listLabours,
  createLabourArchive,
  readyCheck,
  cancelLabour,
  enqueueLabour,
  createLabourWorker,
  resumeLabour,
  resumePausedJobs,
  recoverCancelledLabours,
  workerLiveness,
  isLabourStalled,
};
}
