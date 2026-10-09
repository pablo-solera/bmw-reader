import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { createHash, randomUUID } from "node:crypto";
import { resolveModelSeries } from "./model-series.js";
import { config } from "./config.js";
import { assertWorkerAlive } from "./worker-lock.js";
import { redis } from "./redis.js";
import { BmwClient, BmwRequestCancelledError } from "./bmw/client.js";
import { fetchTypekey } from "./bmw/fetch-typekey.js";
import { deletePrefix, getJsonIfExists, objectKey } from "./storage.js";
import type { ExtractionInput, JobState } from "./types.js";
import { typekeyProgressStore } from "./typekey-progress.js";
import { RedisStateStore } from "reader-core/jobs/state-store";
import { createKeyspace } from "reader-core/redis/keyspace";

const connection = { connection: redis };
export const extractionQueue = new Queue("bmw-extractions", connection);
const bmwKey = createKeyspace("bmw-reader");
const stateKey = (id: string) => bmwKey("job", id);
const labourIndexKey = bmwKey("labours", "index");
const labourIndexReadyKey = bmwKey("labours", "index", "ready");
const labourIndexTtlMs = config.STATE_TTL_SECONDS * 1000;
const stateStore = new RedisStateStore<JobState>(redis, stateKey, config.STATE_TTL_SECONDS);
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = bmwKey("paused-jobs");
const cancellingJobsKey = bmwKey("cancelling-jobs");
const cancellationKey = (id: string) => bmwKey("job", id, "cancel");
const activeTypekeyLock = (path: string) => bmwKey("active-typekey", createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex"));
const activeCancellation = new Map<string, AbortController>();
export function extractionJobId(requestId: string, runId: string, index: number) {
  return `${requestId}--${runId}--${index}`;
}
export function completedJobEvent(requestId: string, typekey: string | undefined, result: unknown) {
  return { event: "extraction_job_completed", requestId, typekey, result };
}
export function setWorkerShuttingDown(value: boolean) {
  workerShuttingDown = value;
  if (value) void activeWorker?.pause(true);
}
export async function state(id: string): Promise<JobState | null> {
  return stateStore.get(id);
}

export function cancellationDecision(status: JobState["status"] | undefined): "not-found" | "already-cancelled" | "conflict" | "cancel" {
  if (!status) return "not-found";
  if (status === "cancelled" || status === "cancelling") return "already-cancelled";
  if (status === "completed") return "conflict";
  return "cancel";
}

export function resumableTypekeyIndex(entries: Array<{ typekey: string }>, summaries: Array<{ typekey: string; awSheetOIDs: number; remainingAwSheetOIDs: number }>) {
  const summaryByTypekey = new Map(summaries.map(item => [item.typekey, item]));
  const pending = entries.findIndex(entry => {
    const item = summaryByTypekey.get(entry.typekey);
    return !item || item.awSheetOIDs === 0 || item.remainingAwSheetOIDs > 0;
  });
  return pending < 0 ? 0 : pending;
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

export type LabourInput = { axCode?: string; edition?: string; manufacturer: string; series?: string; model?: string; date: string; typekeys: Array<{ typekey: string; series?: string; family: string; model?: string }>; language?: string };
export type LabourListFilters = { status?: string[]; axCode?: string; edition?: string; manufacturer?: string };
export type LabourListItem = {
  requestId: string;
  manufacturer: string;
  status: JobState["status"];
  stage: string;
  progress: number | null;
  axCode: string | null;
  edition: string;
  date: string;
  typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function summarizeLabourList(states: Array<JobState | null>, filters: LabourListFilters = {}): LabourListItem[] {
  return states.flatMap(value => {
    if (!value || value.resource !== "labours" || !value.extractionSummary) return [];
    const axCode = value.extractionSummary.axCode ?? null;
    const edition = value.input?.edition ?? value.extractionSummary.date;
    const typekeys = value.extractionSummary.typekeys;
    if (filters.status?.length && !filters.status.includes(value.status)) return [];
    if (filters.axCode !== undefined && axCode !== filters.axCode) return [];
    if (filters.edition !== undefined && edition !== filters.edition) return [];
    if (filters.manufacturer !== undefined && value.input?.manufacturer !== filters.manufacturer) return [];
    return [{
      requestId: value.requestId,
      manufacturer: value.input?.manufacturer ?? "BMW",
      status: value.status,
      stage: value.stage,
      progress: value.progress,
      axCode,
      edition,
      date: value.extractionSummary.date,
      typekeys,
      error: ["completed", "cancelled"].includes(value.status) ? null : value.error ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }];
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function indexLabourState(value: JobState) {
  if (value.resource !== "labours") return;
  const score = Date.parse(value.createdAt);
  if (!Number.isFinite(score)) return;
  await redis.zadd(labourIndexKey, score, value.requestId);
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  let decoded: string;
  try { decoded = Buffer.from(cursor, "base64url").toString("utf8"); }
  catch { throw new Error("cursor is invalid"); }
  const parts = decoded.split(":");
  const offset = Number(parts.length === 2 ? parts[1] : decoded);
  if ((parts.length === 2 && parts[0] !== "v1") || !Number.isSafeInteger(offset) || offset < 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("cursor is invalid");
  return offset;
}
export function listCursorOffset(cursor?: string) { return parseCursor(cursor); }
export function listNextCursor(start: number) { return Buffer.from(`v1:${start}`).toString("base64url"); }

async function claimTypekeyPaths(requestId: string, input: LabourInput): Promise<string[]> {
  const paths = input.typekeys.map((_item, index) => typekeyPathForJob(input, index)).filter((path): path is string => Boolean(path));
  const claimed: string[] = [];
  for (const path of paths) {
    const key = activeTypekeyLock(path);
  const token = `${requestId}:${randomUUID()}`;
    const result = await redis.set(key, token, "EX", config.STATE_TTL_SECONDS, "NX");
    if (result === "OK") { claimed.push(path); continue; }
    const owner = await redis.get(key);
    if (owner?.startsWith(`${requestId}:`)) { claimed.push(path); continue; }
    await releaseTypekeyPaths(requestId, claimed);
    throw new Error(`Extraction already has a queued or active job: ${owner ?? "unknown"}`);
  }
  const ownersKey = bmwKey("active-typekey-owners", requestId);
  const hashes = claimed.map(path => createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex"));
  if (hashes.length) {
    await redis.sadd(ownersKey, ...hashes);
    await redis.expire(ownersKey, config.STATE_TTL_SECONDS);
  }
  return claimed;
}

async function releaseTypekeyPaths(requestId: string, paths: string[]) {
  const hashes = paths.map(path => createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex"));
  const ownerSet = bmwKey("active-typekey-owners", requestId);
  const script = "local owner = redis.call('GET', KEYS[1]); if owner and string.sub(owner, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await Promise.all(hashes.map(hash => redis.eval(script, 1, activeTypekeyLock(hash), `${requestId}:`)));
  if (hashes.length) await redis.srem(ownerSet, ...hashes);
  if (!(await redis.scard(ownerSet))) await redis.del(ownerSet);
}

async function releaseTypekeyHashes(requestId: string, hashes: string[]) {
  const script = "local owner = redis.call('GET', KEYS[1]); if owner and string.sub(owner, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await Promise.all(hashes.map(hash => redis.eval(script, 1, bmwKey("active-typekey", hash), `${requestId}:`)));
  const ownersKey = bmwKey("active-typekey-owners", requestId);
  if (hashes.length) await redis.srem(ownersKey, ...hashes);
  if (!(await redis.scard(ownersKey))) await redis.del(ownersKey);
}

async function renewTypekeyPaths(requestId: string) {
  const ownersKey = bmwKey("active-typekey-owners", requestId);
  const hashes = await redis.smembers(ownersKey);
  const script = "local owner = redis.call('GET', KEYS[1]); if owner and string.sub(owner, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end";
  await Promise.all(hashes.map(hash => redis.eval(script, 1, activeTypekeyLockHash(hash), `${requestId}:`, config.STATE_TTL_SECONDS)));
  if (hashes.length) await redis.expire(ownersKey, config.STATE_TTL_SECONDS);
}

function activeTypekeyLockHash(hash: string) { return bmwKey("active-typekey", hash); }

async function releaseCompletedTypekeyPath(requestId: string, input: LabourInput, typekey: string) {
  const index = input.typekeys.findIndex(item => item.typekey === typekey);
  if (index < 0) return;
  const path = typekeyPathForJob(input, index);
  if (path) await releaseTypekeyPaths(requestId, [path]);
}

export async function ensureLabourIndex() {
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

export function typekeyPathForJob(input: LabourInput, index: number): string | null {
  const entry = input.typekeys[index];
  if (!entry) return null;
  try {
    return ["BMW", input.manufacturer, "labour", resolveModelSeries(entry.series, input.series), entry.family, input.date, entry.typekey].join("/");
  } catch { return null; }
}

export function incompleteTypekeysForCleanup(input: LabourInput, completedPaths: Set<string>, activePaths: Set<string>) {
  return input.typekeys.flatMap((entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path && !completedPaths.has(path) && !activePaths.has(path) ? [{ entry, path }] : [];
  });
}

export async function listLabours(filters: LabourListFilters = {}, cursor?: string, count = 50): Promise<{ items: LabourListItem[]; nextCursor: string | null }> {
  await ensureLabourIndex();
  const start = parseCursor(cursor);
  const cutoff = Date.now() - labourIndexTtlMs;
  await redis.zremrangebyscore(labourIndexKey, "-inf", cutoff);
  const items: LabourListItem[] = [];
  let hasMore = false;
  let scanned = 0;
  let exhausted = false;
  while (items.length <= count && !exhausted) {
    const batchSize = Math.max(50, count + 1);
    const batchStart = start + scanned;
    const requestIds = await redis.zrevrangebyscore(labourIndexKey, "+inf", cutoff, "LIMIT", batchStart, batchSize);
    if (requestIds.length < batchSize) exhausted = true;
    if (!requestIds.length) break;
    const values = await redis.mget(...requestIds.map(stateKey));
    let matchingScanned = 0;
    for (const raw of values) {
      if (raw) items.push(...summarizeLabourList([JSON.parse(raw) as JobState], filters));
      matchingScanned++;
      if (items.length > count) break;
    }
    if (items.length > count) { scanned += matchingScanned; hasMore = true; break; }
    scanned += requestIds.length;
  }
  const pageItems = items.slice(0, count);
  return { items: pageItems, nextCursor: hasMore ? listNextCursor(start + scanned) : null };
}

export async function readyCheck() {
  await assertWorkerAlive(redis);
}

export async function cleanupCancelledLabour(requestId: string, input: LabourInput) {
  const cancelKey = cancellationKey(requestId);
  const deleted: Array<{ typekey: string; deletedObjects: number; skipped: boolean }> = [];
  const completedPaths = new Set<string>();
  const markers = await Promise.all(input.typekeys.map((entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path ? getJsonIfExists(`${objectKey(...path.split("/"))}/${entry.typekey}_completed.json`) : Promise.resolve(undefined);
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
      const prefix = objectKey(...relativePath.split("/"));
      try {
        const hash = createHash("sha256").update(`${config.S3_BUCKET}\n${relativePath}`).digest("hex");
        if (!ownedHashes.has(hash) || await getJsonIfExists(`${prefix}/${entry.typekey}_completed.json`)) {
          deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
          return;
        }
        const deletedObjects = await deletePrefix(prefix);
        await typekeyProgressStore.clear(relativePath);
        deleted.push({ typekey: entry.typekey, deletedObjects, skipped: false });
      } catch (error) {
        console.error(JSON.stringify({ event: "typekey_cleanup_failed", requestId, typekey: entry.typekey, path: relativePath, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    }));
  } finally {
    await redis.del(cancelKey);
    const uncompletedHashes = cleanupTargets.filter(target => !deleted.some(item => item.typekey === target.entry.typekey && !item.skipped)).map(target => createHash("sha256").update(`${config.S3_BUCKET}\n${target.path}`).digest("hex"));
    await releaseTypekeyHashes(requestId, uncompletedHashes);
    for (const target of cleanupTargets) {
      if (deleted.some(result => result.typekey === target.entry.typekey && !result.skipped)) continue;
      await typekeyProgressStore.recordIncompleteFailure(target.path, `Extraction ${requestId} was cancelled; create a new labour request to retry`);
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

export async function cancelLabour(requestId: string) {
  const current = await state(requestId);
  const decision = cancellationDecision(current?.status);
  if (decision === "not-found") throw Object.assign(new Error("Labour request not found"), { statusCode: 404 });
  if (decision === "conflict") throw Object.assign(new Error("Completed labour requests cannot be cancelled"), { statusCode: 409 });
  if (decision === "already-cancelled") return { requestId, status: current!.status };
  const alreadyRunningCleanup = await redis.exists(cancellationKey(requestId));
  if (alreadyRunningCleanup) return { requestId, status: "cancelling" as const };
  const cancelKey = cancellationKey(requestId);
  await redis.set(cancelKey, "1", "EX", config.STATE_TTL_SECONDS);
  await redis.sadd(cancellingJobsKey, requestId);
  await redis.expire(cancellingJobsKey, config.STATE_TTL_SECONDS);
  const cancelling: JobState = { ...current!, status: "cancelling", stage: "cancelling" };
  await updateState(requestId, cancelling);
  const claimedPaths = current?.typekeyPaths ?? [];
  if (claimedPaths.length) await releaseTypekeyPaths(requestId, claimedPaths);
  const job = current!.bullJobId ? await extractionQueue.getJob(current!.bullJobId) : null;
  const jobState = job ? await job.getState() : "unknown";
  activeCancellation.get(requestId)?.abort();
  if (job && jobState === "active") {
    console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: true }));
    return { requestId, status: "cancelling" as const };
  }
  console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: false }));
  if (job && ["waiting", "delayed", "failed"].includes(jobState)) {
    try { await job.remove(); } catch (error) { console.warn(JSON.stringify({ event: "cancel_job_remove_failed", requestId, jobId: job.id, error: error instanceof Error ? error.message : String(error) })); }
  }
  const currentJobAfterRemove = current!.bullJobId ? await extractionQueue.getJob(current!.bullJobId) : null;
  if (currentJobAfterRemove && await currentJobAfterRemove.getState() === "active") {
    activeCancellation.get(requestId)?.abort();
    console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: true, raced: true }));
    return { requestId, status: "cancelling" as const };
  }
  try {
    const result = await finalizeCancelledJob(requestId, current!);
  return { requestId, status: "cancelled" as const, ...result };
  } catch (error) { throw error; }
}

async function cancellationRecoveryCandidates() {
  const requestIds = await redis.smembers(cancellingJobsKey);
  const pending: string[] = [];
  for (const requestId of requestIds) {
    if (await redis.pttl(cancellationKey(requestId)) > 0) pending.push(requestId);
    else await redis.srem(cancellingJobsKey, requestId);
  }
  return pending;
}

function validatePathSegment(field: string, value: string) {
  if (!/^[A-Za-z0-9 _.'-]+$/.test(value) || value === "." || value === "..") throw new Error(`${field} contains invalid path characters`);
}
const baseExtractionDate = (yyyymmdd: string) => {
  if (!/^\d{8}$/.test(yyyymmdd)) throw Object.assign(new Error("date must use YYYYMMDD"), { code: "VALIDATION_ERROR" });
  const value = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  if (value.toISOString().slice(0, 10).replace(/-/g, "") !== yyyymmdd) throw Object.assign(new Error("Invalid calendar date"), { code: "VALIDATION_ERROR" });
  return value;
};

async function queueJob(requestId: string, data: Record<string, unknown>, jobId: string) {
  await extractionQueue.add("extract", { requestId, ...data }, { jobId, removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: "exponential", delay: 30000 }, ignoreDependencyOnFailure: true });
}

export async function enqueueLabour(input: LabourInput, resumeAt = 0, requestId = randomUUID()) {
  validatePathSegment("manufacturer", input.manufacturer);
  if (input.model) validatePathSegment("model", input.model);
  if (input.axCode && !/^[A-Za-z0-9_]+$/.test(input.axCode)) throw new Error("axCode may only contain letters, digits and underscores");
  if (input.edition && !/^[A-Za-z0-9_]+$/.test(input.edition)) throw new Error("edition may only contain letters, digits and underscores");
  baseExtractionDate(input.date);
  if (!input.typekeys.length || input.typekeys.some(item => !/^[A-Z0-9]{4}$/.test(item.typekey) || !/^[A-Z0-9]+$/.test(item.family) || (item.model ?? input.model) !== undefined && !/^[A-Za-z0-9 _.'-]+$/.test((item.model ?? input.model)!))) throw new Error("Invalid labour typekeys/families/models");
  const entries = input.typekeys.map(entry => ({ ...entry, series: resolveModelSeries(entry.series, input.series) }));
  if (new Set(entries.map(item => item.typekey)).size !== entries.length) throw new Error("Labour typekeys must be unique");
  const previousState = await state(requestId);
  if (previousState) {
    if (previousState.status === "cancelled" || previousState.status === "cancelling") throw new Error("Cancelled labour requests are final; submit a new request ID");
    if (!new Set(["failed", "paused"]).has(previousState.status)) throw new Error(`Request ID already exists with status ${previousState.status}`);
    const completed = new Set((previousState.extractionSummary?.typekeys ?? []).filter(item => item.remainingAwSheetOIDs === 0 && item.awSheetOIDs > 0).map(item => item.typekey));
    const nextIndex = entries.findIndex(item => !completed.has(item.typekey));
    resumeAt = nextIndex < 0 ? entries.length - 1 : nextIndex;
  }
  const replacementAttempt = Boolean(previousState);
  const normalizedInput: LabourInput = { ...input, typekeys: entries };
  const completedTypekeys = new Set((previousState?.extractionSummary?.typekeys ?? []).filter(item => item.awSheetOIDs > 0 && item.remainingAwSheetOIDs === 0).map(item => item.typekey));
  const pendingEntries = entries.filter(item => !completedTypekeys.has(item.typekey));
  const pendingInput: LabourInput = { ...normalizedInput, typekeys: pendingEntries };
  const pathsToClaim = pendingEntries.map((_entry, index) => typekeyPathForJob(pendingInput, index)).filter((path): path is string => Boolean(path));
  const newClaims = pathsToClaim.length
    ? await claimTypekeyPaths(requestId, pendingInput)
    : [];
  const claimedPaths = [...(previousState?.typekeyPaths ?? []), ...newClaims];
  const existingCancellation = await redis.exists(cancellationKey(requestId));
  if (existingCancellation) {
    if (newClaims.length) await releaseTypekeyPaths(requestId, newClaims);
    throw new Error("This labour request is being cancelled and cannot be re-enqueued");
  }
  if (previousState?.bullJobId) {
    const existing = await extractionQueue.getJob(previousState.bullJobId);
    if (existing && ["active", "waiting", "delayed"].includes(await existing.getState())) {
      if (newClaims.length) await releaseTypekeyPaths(requestId, newClaims);
      throw new Error("Extraction already has a queued or active job");
    }
  }
  const initial: JobState = {
    requestId, resource: "labours", status: "queued", stage: "queued", progress: 0, input: { manufacturer: input.manufacturer, series: entries[0]?.series, model: input.model ?? entries[0]?.model, family: entries[0]?.family ?? "", axCode: input.axCode, edition: input.edition ?? input.date, date: input.date, language: input.language },
    typekeyPaths: claimedPaths,
    extractionSummary: { typekeys: entries.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })), date: input.date, axCode: input.axCode },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const runId = randomUUID();
    const jobId = extractionJobId(requestId, runId, resumeAt);
    initial.bullJobId = jobId;
    await saveState(initial, true);
    try {
    const typekeyPaths = normalizedInput.typekeys.map((_entry, index) => typekeyPathForJob(normalizedInput, index)).filter((path): path is string => Boolean(path));
    await queueJob(requestId, { input: normalizedInput, index: resumeAt, runId, replacementAttempt, typekeyPaths }, jobId);
    } catch (error) {
    await redis.del(stateKey(requestId));
    if (newClaims.length) await releaseTypekeyPaths(requestId, newClaims);
    throw error;
  }
  return requestId;
}

export async function processLabourTypekey(job: Job) {
  const { requestId, input, index, runId: jobRunId } = job.data as { requestId: string; input: LabourInput; index: number; runId?: string };
  return processTypekeyJob(job, requestId, input, index, jobRunId, Boolean(job.data.replacementAttempt));
}

async function processTypekeyJob(job: Job, requestId: string, input: LabourInput, index: number, jobRunId?: string, replacementAttempt = false) {
  const runId = jobRunId ?? randomUUID();
  const entry = input.typekeys[index];
  if (!entry) throw new Error(`Missing model typekey at index ${index}`);
  if (await redis.exists(cancellationKey(requestId))) {
    const current = await state(requestId);
    if (current) await finalizeCancelledJob(requestId, current);
    return { kind: "cancelled", requestId };
  }
    const model = entry.model ?? input.model;
    const series = resolveModelSeries(entry.series, input.series);
  const typekeyInput: ExtractionInput = { manufacturer: input.manufacturer, series, model: model ?? "", family: entry.family, axCode: input.axCode, edition: input.edition ?? input.date, language: input.language };
  const typekeyStartedAt = Date.now();
  let currentHgs = 0;
  const controller = new AbortController();
  const heartbeatKey = bmwKey("job", requestId, "heartbeat");
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
    await updateState(requestId, { status: "downloading", stage: `${entry.typekey}:preparing` });
    console.info(JSON.stringify({ event: "typekey_started", requestId, typekey: entry.typekey, index }));
    const client = new BmwClient(input.language, async event => {
      if (event.recovered) {
        const current = await state(requestId);
        if (current) await saveState({ ...current, status: "downloading", stage: `${entry.typekey}:resumed`, rateLimitInfo: undefined });
        return;
      }
      const retryAt = new Date(Date.now() + event.cooldownMs).toISOString();
      const current = await state(requestId);
    if (current) await saveState({
        ...current,
        status: event.cooldownMs > 10000 ? "rate-limited" : current.status,
        stage: event.cooldownMs > 10000 ? `${entry.typekey}:rate-limited` : current.stage,
        rateLimitInfo: { count: event.count, cooldownUntil: retryAt, retryAfterMs: event.retryAfterMs },
      });
    }, controller.signal);
      const result = await fetchTypekey(client, typekeyInput, entry.typekey, requestId, baseExtractionDate(input.date), async event => {
      if (event.stage !== "aw-sheet-details") await updateState(requestId, { status: "downloading", rateLimitInfo: undefined });
      const completed = event.completed;
      const total = event.total;
      const current = await state(requestId);
      const existing = current?.extractionSummary?.typekeys ?? [];
      currentHgs = event.hgs ?? currentHgs;
      const summary = { typekey: entry.typekey, series, family: entry.family, model, hgs: currentHgs, awSheetOIDs: total, completedAwSheetOIDs: completed, remainingAwSheetOIDs: Math.max(0, total - completed), failedOids: event.failed ?? 0 };
      const cancelling = controller.signal.aborted;
      const nextStatus = cancelling ? "cancelling" : workerShuttingDown && event.stage === "aw-sheet-details" ? "paused" : "downloading";
      await updateState(requestId, { status: nextStatus, stage: cancelling ? `${entry.typekey}:cancelling` : nextStatus === "paused" ? `${entry.typekey}:pausing` : `${entry.typekey}:${event.stage}`, progress: Math.min(99, Math.floor(index / input.typekeys.length * 100 + (total ? completed / total : 0) * (100 / input.typekeys.length))), extractionSummary: { typekeys: [...existing.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode } });
      if (event.stage === "aw-sheet-details") console.info(JSON.stringify({ event: "typekey_progress", requestId, typekey: entry.typekey, completed, total, failed: event.failed ?? 0 }));
      }, true, () => workerShuttingDown || controller.signal.aborted, undefined, replacementAttempt);
    if (controller.signal.aborted || await redis.exists(cancellationKey(requestId))) {
      const current = await state(requestId);
      if (current) await finalizeCancelledJob(requestId, current);
      return { kind: "cancelled", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }
    const current = await state(requestId);
    const summariesBefore = current?.extractionSummary?.typekeys ?? [];
    if (result.paused) {
      const pausedSummary = { typekey: entry.typekey, series, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: result.remainingAwSheetOIDs, failedOids: Object.keys(result.failedOids ?? {}).length };
      await updateState(requestId, { status: "paused", stage: `${entry.typekey}:paused`, extractionSummary: { typekeys: [...summariesBefore.filter(item => item.typekey !== entry.typekey), pausedSummary], date: input.date, axCode: input.axCode } });
      await redis.sadd(pausedJobsKey, requestId);
      console.info(JSON.stringify({ event: "extraction_paused", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs }));
      return { kind: "paused", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }
    console.info(JSON.stringify({ event: "typekey_completed", requestId, typekey: entry.typekey, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, durationMs: Date.now() - typekeyStartedAt }));
    await releaseCompletedTypekeyPath(requestId, input, entry.typekey);
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, series, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0, failedOids: 0 }];
    if (index + 1 < input.typekeys.length) {
      const nextJobId = extractionJobId(requestId, runId, index + 1);
      await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode }, bullJobId: nextJobId });
      const typekeyPaths = input.typekeys.map((_entry, typekeyIndex) => typekeyPathForJob(input, typekeyIndex)).filter((path): path is string => Boolean(path));
      await queueJob(requestId, { input, index: index + 1, runId, typekeyPaths }, nextJobId);
      return { kind: "typekey", requestId, typekey: entry.typekey, nextTypekey: input.typekeys[index + 1]!.typekey };
    }
     return await finishLabour(requestId, input, summaries);
  } catch (error) {
    if (error instanceof BmwRequestCancelledError || controller.signal.aborted || await redis.exists(cancellationKey(requestId))) {
      const current = await state(requestId);
      if (current) await finalizeCancelledJob(requestId, current);
      return { kind: "cancelled", requestId, typekey: entry.typekey };
    }
    const retryWindowExhausted = error instanceof Error && "retryWindowExhausted" in error && error.retryWindowExhausted === true;
    const deferredFailuresFinal = error instanceof Error && error.name === "TypekeyOidFailures";
    const outageAbort = error instanceof Error && error.message.includes("BMW appears unavailable after 3 consecutive OID failures");
    const unrecoverable = retryWindowExhausted || deferredFailuresFinal || outageAbort;
    const retrying = !unrecoverable && job.attemptsMade + 1 < Number(job.opts.attempts ?? 1);
    const lastState = await state(requestId);
    await updateState(requestId, { status: retrying ? "queued" : "failed", stage: retrying ? `${entry.typekey}:retrying` : "failed", progress: lastState?.progress ?? null, error: error instanceof Error ? error.message : String(error) });
    if (retrying && job.data.index + 1 < input.typekeys.length) {
      const nextIndex = Number(job.data.index) + 1;
      const nextJobId = extractionJobId(requestId, runId, nextIndex);
      await updateState(requestId, { bullJobId: nextJobId });
    }
    if (!retrying) {
      const failedState = await state(requestId);
      if (failedState?.typekeyPaths?.length) await releaseTypekeyPaths(requestId, failedState.typekeyPaths);
      await updateState(requestId, { typekeyPaths: undefined });
    }
    console.error(JSON.stringify({ event: retrying ? "typekey_attempt_failed" : "typekey_failed", requestId, typekey: entry.typekey, attempt: job.attemptsMade + 1, willRetry: retrying, error: error instanceof Error ? error.message : String(error) }));
    if (unrecoverable) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new UnrecoverableError(message);
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (activeCancellation.get(requestId) === controller) activeCancellation.delete(requestId);
    const heartbeat = await redis.get(heartbeatKey);
    if (heartbeat && JSON.parse(heartbeat).runId === runId) await redis.del(heartbeatKey);
  }
}

async function finishLabour(requestId: string, input: LabourInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  const startedAt = Date.parse((await state(requestId))?.createdAt ?? new Date().toISOString());
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, resource: "labours", error: undefined, rateLimitInfo: undefined, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
  const completedState = await state(requestId);
  if (completedState?.typekeyPaths?.length) await releaseTypekeyPaths(requestId, completedState.typekeyPaths);
  await updateState(requestId, { typekeyPaths: undefined });
  await redis.srem(pausedJobsKey, requestId);
  const durationMs = Date.now() - startedAt;
  console.info(JSON.stringify({ event: "extraction_completed", requestId, durationMs }));
  return { kind: "extraction", requestId, durationMs };
}

export function createExtractionWorker() {
  activeWorker = new Worker("bmw-extractions", processLabourTypekey, {
    ...connection, concurrency: config.JOB_CONCURRENCY, stalledInterval: 15000, lockDuration: 60000, maxStalledCount: 100,
    settings: { backoffStrategy: attemptsMade => Math.min(30000 * 2 ** attemptsMade, 300000) },
  });
  return activeWorker;
}

export async function resumeLabour(requestId: string, force = false, startupRecovery = false) {
  const current = await state(requestId);
  if (!current || current.resource !== "labours" || !current.input || !current.extractionSummary) throw new Error("Resumable extraction not found");
  if (current.status === "cancelled" || current.status === "cancelling") throw new Error("Cancelled extractions cannot be resumed");
  const heartbeat = await redis.pttl(`bmw-reader:job:${requestId}:heartbeat`);
  if (force && !startupRecovery && !workerShuttingDown && await redis.get("bmw-reader:worker:singleton")) throw new Error("Force resume is disabled while a worker is active");
  if (!["failed", "downloading", "queued", "paused", "rate-limited"].includes(current.status)) throw new Error(`Extraction is not resumable (current status: ${current.status})`);
  if (heartbeat > 0 && !force && !startupRecovery && current.status === "downloading") throw new Error("Extraction is currently active");
  const existingJob = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
  if (existingJob) {
    const existingJobState = await existingJob.getState();
    if (["active", "waiting", "delayed"].includes(existingJobState)) throw new Error("Extraction already has a queued or active job");
    if (["failed", "completed"].includes(existingJobState)) await existingJob.remove().catch(() => undefined);
  }
  const savedInput = current.input as ExtractionInput;
  const entries = current.extractionSummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) }));
  const labourInput: LabourInput = {
    manufacturer: savedInput.manufacturer, model: savedInput.model, axCode: savedInput.axCode,
    edition: savedInput.edition, date: current.extractionSummary.date,
    language: savedInput.language, typekeys: entries,
  };
  const runId = randomUUID();
  const summary = current.extractionSummary.typekeys;
  const resumeAt = resumableTypekeyIndex(entries, summary);
  const jobId = extractionJobId(requestId, runId, resumeAt);
  const completedTypekeys = new Set(summary.filter(item => item.awSheetOIDs > 0 && item.remainingAwSheetOIDs === 0).map(item => item.typekey));
  const pendingEntries = entries.filter(entry => !completedTypekeys.has(entry.typekey));
  const pendingInput: LabourInput = { ...labourInput, typekeys: pendingEntries };
  const pathsToClaim = pendingInput.typekeys.map((_entry, index) => typekeyPathForJob(pendingInput, index)).filter((path): path is string => Boolean(path));
  const newClaims = pathsToClaim.length
    ? await claimTypekeyPaths(requestId, pendingInput)
    : [];
  const claimedPaths = [...(current.typekeyPaths ?? []), ...newClaims];
  await updateState(requestId, { resource: "labours", typekeyPaths: claimedPaths, status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined, bullJobId: jobId });
  await redis.srem(pausedJobsKey, requestId);
  try {
    const typekeyPaths = labourInput.typekeys.map((_entry, index) => typekeyPathForJob(labourInput, index)).filter((path): path is string => Boolean(path));
    await queueJob(requestId, { input: labourInput, index: resumeAt, runId, replacementAttempt: true, typekeyPaths }, jobId);
  } catch (error) {
    await updateState(requestId, { bullJobId: current.bullJobId, status: current.status, stage: current.stage, error: current.error });
    if (newClaims.length) await releaseTypekeyPaths(requestId, newClaims);
    throw error;
  }
  return { requestId, resumedAtTypekey: entries[resumeAt]?.typekey ?? entries[0]?.typekey, queue: "bmw-extractions" };
}

export async function resumePausedJobs() {
  const requestIds = new Set(await redis.smembers(pausedJobsKey));
  const indexedIds = await requestIdsFromIndex();
  for (const requestId of indexedIds) {
    const current = await state(requestId);
    if (current && ["downloading", "queued", "rate-limited", "paused"].includes(current.status)) requestIds.add(requestId);
  }
  const resumed = new Set<string>();
  for (const requestId of requestIds) {
    const current = await state(requestId);
    if (!current || !["downloading", "queued", "rate-limited", "paused"].includes(current.status)) continue;
    const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
    if (job && ["active", "waiting", "delayed"].includes(await job.getState())) { resumed.add(requestId); continue; }
    try { await resumeLabour(requestId, false, true); resumed.add(requestId); }
    catch (error) { console.warn(JSON.stringify({ event: "orphan_job_resume_skipped", requestId, error: error instanceof Error ? error.message : String(error) })); }
  }
  return resumed.size;
}

export async function recoverCancelledLabours() {
  let recovered = 0;
  for (const requestId of await requestIdsFromIndex()) {
      const current = await state(requestId);
      if (!current || current.status !== "cancelling") continue;
      const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
      if (!job || await job.getState() !== "active") {
      await finalizeCancelledJob(requestId, current);
      recovered++;
    }
  }
  return recovered;
}

export async function workerLiveness() {
  const [heartbeat, ttl, queueCounts] = await Promise.all([
    redis.get(bmwKey("worker", "heartbeat")), redis.pttl(bmwKey("worker", "heartbeat")),
    extractionQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
  ]);
  return { alive: ttl > 0, concurrency: config.JOB_CONCURRENCY, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: "bmw-extractions", queueCounts };
}

export async function isLabourStalled(requestId: string, currentState?: JobState) {
  const current = currentState ?? await state(requestId);
  if (!current || current.status === "cancelled" || current.status === "cancelling" || !["downloading", "queued", "rate-limited"].includes(current.status)) return false;
  if (await redis.pttl(`bmw-reader:job:${requestId}:heartbeat`) > 0) return false;
  const job = current.bullJobId ? await extractionQueue.getJob(current.bullJobId) : null;
  if (!job) return true;
  const jobState = await job.getState();
  return !["active", "waiting", "delayed"].includes(jobState);
}
