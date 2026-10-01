import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { metricRequestContext } from "./metrics-context.js";
import { resolveModelSeries } from "./model-series.js";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { BmwClient, BmwRequestCancelledError } from "./bmw/client.js";
import { fetchTypekey } from "./bmw/fetch-typekey.js";
import { deletePrefix, getJsonIfExists, objectKey, setS3PutObserver } from "./storage.js";
import { getBmwMetrics, logBmwMetricsMinute as logBmwMetricsMinuteGlobal, recordCompletedOid, recordS3PutLatency } from "./rate-metrics.js";
import type { ExtractionInput, JobState } from "./types.js";
import { typekeyProgressStore } from "./typekey-progress.js";

const connection = { connection: redis };
export const extractionQueue = new Queue("bmw-extractions", connection);
const stateKey = (id: string) => `bmw-reader:job:${id}`;
const labourIndexKey = "bmw-reader:labours:index";
const labourIndexReadyKey = "bmw-reader:labours:index:ready";
const labourIndexTtlMs = config.STATE_TTL_SECONDS * 1000;
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = "bmw-reader:paused-jobs";
const cancellationKey = (id: string) => `bmw-reader:job:${id}:cancel`;
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
setS3PutObserver(elapsedMs => recordS3PutLatency(metricRequestContext.getStore(), elapsedMs));
export async function state(id: string): Promise<JobState | null> {
  const value = await redis.get(stateKey(id));
  return value ? JSON.parse(value) as JobState : null;
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
async function saveState(value: JobState) {
  value.updatedAt = new Date().toISOString();
  await redis.set(stateKey(value.requestId), JSON.stringify(value), "EX", config.STATE_TTL_SECONDS);
  await indexLabourState(value);
}
async function updateState(id: string, patch: Partial<JobState>) {
  const current = await state(id);
  if (current) await saveState({ ...current, ...patch });
}

export type LabourInput = { axCode?: string; edition?: string; manufacturer: string; series?: string; model?: string; date: string; group?: string; typekeys: Array<{ typekey: string; series?: string; family: string; model?: string }>; language?: string };
type ModelInput = LabourInput;
export type LabourListFilters = { status?: string[]; axCode?: string; edition?: string; typekey?: string };
export type LabourListItem = {
  requestId: string;
  status: JobState["status"];
  stage: string;
  progress: number | null;
  axCode: string | null;
  edition: string;
  date: string;
  typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>;
  totals: { typekeys: number; completedTypekeys: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function summarizeLabourList(states: Array<JobState | null>, filters: LabourListFilters = {}): LabourListItem[] {
  return states.flatMap(value => {
    if (!value || !["labours", "models"].includes(value.resource ?? "") || !value.extractionSummary) return [];
    const axCode = value.extractionSummary.axCode ?? null;
    const edition = value.input?.edition ?? value.extractionSummary.date;
    const typekeys = value.extractionSummary.typekeys;
    if (filters.status?.length && !filters.status.includes(value.status)) return [];
    if (filters.axCode !== undefined && axCode !== filters.axCode) return [];
    if (filters.edition !== undefined && edition !== filters.edition) return [];
    if (filters.typekey !== undefined && !typekeys.some(item => item.typekey === filters.typekey)) return [];
  const completedTypekeys = value.status === "completed"
      ? typekeys.length
      : typekeys.filter(item => item.awSheetOIDs > 0 && item.remainingAwSheetOIDs === 0).length;
    return [{
      requestId: value.requestId,
      status: value.status,
      stage: value.stage,
      progress: value.progress,
      axCode,
      edition,
      date: value.extractionSummary.date,
      typekeys,
      totals: { typekeys: typekeys.length, completedTypekeys },
      error: ["completed", "cancelled"].includes(value.status) ? null : value.error ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }];
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function indexLabourState(value: JobState) {
  if (!["labours", "models"].includes(value.resource ?? "")) return;
  const score = Date.parse(value.createdAt);
  if (!Number.isFinite(score)) return;
  await redis.zadd(labourIndexKey, score, value.requestId);
  await redis.pexpire(labourIndexKey, labourIndexTtlMs);
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
  const stream = redis.scanStream({ match: "bmw-reader:job:*", count: 250 });
  for await (const keys of stream) {
    for (const key of keys as string[]) {
      if (key.endsWith(":heartbeat") || key.endsWith(":typekeys") || key.endsWith(":cancel") || key.endsWith(":cancel-cleanup-lock")) continue;
      const value = await state(key.slice("bmw-reader:job:".length));
      if (value && Date.parse(value.createdAt) >= cutoff) await indexLabourState(value);
    }
  }
  await redis.zremrangebyscore(labourIndexKey, "-inf", cutoff);
  await redis.pexpire(labourIndexKey, labourIndexTtlMs);
  await redis.set(labourIndexReadyKey, "1", "PX", labourIndexTtlMs);
  } finally {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, lockKey, lockToken);
  }
}

export function typekeyPathForJob(input: LabourInput, index: number): string | null {
  const entry = input.typekeys[index];
  if (!entry) return null;
  try {
    return [input.group ?? "BMW", input.manufacturer, "labour", resolveModelSeries(entry.series, input.series), entry.family, input.date, entry.typekey].join("/");
  } catch { return null; }
}

export function incompleteTypekeysForCleanup(input: LabourInput, completedPaths: Set<string>, activePaths: Set<string>) {
  return input.typekeys.flatMap((entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path && !completedPaths.has(path) && !activePaths.has(path) ? [{ entry, path }] : [];
  });
}

export async function listLabours(filters: LabourListFilters = {}): Promise<LabourListItem[]> {
  await ensureLabourIndex();
  const cutoff = Date.now() - labourIndexTtlMs;
  await redis.zremrangebyscore(labourIndexKey, "-inf", cutoff);
  const requestIds = (await redis.zrangebyscore(labourIndexKey, cutoff, "+inf")).reverse();
  const values = requestIds.length ? await redis.mget(...requestIds.map(stateKey)) : [];
  const missingIds = requestIds.filter((_, index) => values[index] === null);
  if (missingIds.length) await redis.zrem(labourIndexKey, ...missingIds);
  return summarizeLabourList(values.map(value => value ? JSON.parse(value) as JobState : null), filters);
}

export async function cleanupCancelledLabour(requestId: string, input: LabourInput) {
  const cancelKey = cancellationKey(requestId);
  const otherActiveTypekeyPaths = new Set<string>();
  const activeJobs = await extractionQueue.getJobs(["active"], 0, -1, true);
  for (const job of activeJobs) {
    if (String(job.data.requestId) === requestId) continue;
    const jobInput = job.data.input as LabourInput | undefined;
    if (!jobInput) continue;
    const path = typekeyPathForJob(jobInput, Number(job.data.index));
    if (path) otherActiveTypekeyPaths.add(path);
  }

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
  const cleanupTargets = incompleteTypekeysForCleanup(input, completedPaths, otherActiveTypekeyPaths);
  try {
    for (const { entry, path: relativePath } of cleanupTargets) {
      const prefix = objectKey(...relativePath.split("/"));
      try {
        const activeAtDelete = (await extractionQueue.getJobs(["active"], 0, -1, true)).some(job => {
          const jobInput = job.data.input as LabourInput | undefined;
          return jobInput && typekeyPathForJob(jobInput, Number(job.data.index)) === relativePath;
        });
        if (activeAtDelete || await getJsonIfExists(`${prefix}/${entry.typekey}_completed.json`)) {
          deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
          continue;
        }
        const deletedObjects = await deletePrefix(prefix);
        await typekeyProgressStore.clear(relativePath);
        deleted.push({ typekey: entry.typekey, deletedObjects, skipped: false });
      } catch (error) {
        console.error(JSON.stringify({ event: "typekey_cleanup_failed", requestId, typekey: entry.typekey, path: relativePath, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    }
  } finally {
    await redis.del(cancelKey);
    for (const target of cleanupTargets) {
      if (deleted.some(result => result.typekey === target.entry.typekey && !result.skipped)) continue;
      await typekeyProgressStore.recordIncompleteFailure(target.path, `Extraction ${requestId} was cancelled; create a new labour request to retry`);
    }
  }
  for (const entry of input.typekeys) if (!deleted.some(result => result.typekey === entry.typekey)) deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
  return deleted;
}

async function finalizeCancelledJob(requestId: string, current: JobState) {
  const lockKey = `bmw-reader:job:${requestId}:cancel-cleanup-lock`;
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
  const cancelling: JobState = { ...current!, status: "cancelling", stage: "cancelling" };
  await saveState(cancelling);
  const [activeJobs, pendingJobs, failedJobs] = await Promise.all([
    extractionQueue.getJobs(["active"], 0, -1, true),
    extractionQueue.getJobs(["waiting", "delayed", "paused"], 0, -1, true),
    extractionQueue.getJobs(["failed"], 0, -1, true),
  ]);
  const activeJob = activeJobs.find(job => String(job.data.requestId) === requestId);
  activeCancellation.get(requestId)?.abort();
  if (activeJob) {
    console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: true }));
    return { requestId, status: "cancelling" as const };
  }
  console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: false }));
  for (const job of [...pendingJobs, ...failedJobs]) {
    if (String(job.data.requestId) !== requestId) continue;
    try { await job.remove(); } catch (error) { console.warn(JSON.stringify({ event: "cancel_job_remove_failed", requestId, jobId: job.id, error: error instanceof Error ? error.message : String(error) })); }
  }
  const racedActiveJob = (await extractionQueue.getJobs(["active"], 0, -1, true)).find(job => String(job.data.requestId) === requestId);
  if (racedActiveJob) {
    activeCancellation.get(requestId)?.abort();
    console.info(JSON.stringify({ event: "extraction_cancel_requested", requestId, active: true, raced: true }));
    return { requestId, status: "cancelling" as const };
  }
  try {
    const result = await finalizeCancelledJob(requestId, current!);
    return { requestId, status: "cancelled" as const, ...result };
  } catch (error) { throw error; }
}

export async function cancellationRecoveryCandidates() {
  const stream = redis.scanStream({ match: "bmw-reader:job:*:cancel", count: 100 });
  const requestIds: string[] = [];
  for await (const keys of stream) {
    for (const key of keys as string[]) {
      const requestId = key.slice("bmw-reader:job:".length, -":cancel".length);
      if (await redis.pttl(`bmw-reader:job:${requestId}:cancel`) > 0) requestIds.push(requestId);
      else await redis.del(key);
    }
  }
  return requestIds;
}

function validatePathSegment(field: string, value: string) {
  if (!/^[A-Za-z0-9 _.'-]+$/.test(value) || value === "." || value === "..") throw new Error(`${field} contains invalid path characters`);
}
const baseExtractionDate = (yyyymmdd: string) => {
  if (!/^\d{8}$/.test(yyyymmdd)) throw new Error("date must use YYYYMMDD");
  const value = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  if (value.toISOString().slice(0, 10).replace(/-/g, "") !== yyyymmdd) throw new Error("Invalid calendar date");
  return value;
};

async function queueJob(queue: Queue, name: string, requestId: string, data: Record<string, unknown>, jobId: string) {
  await queue.add(name, { requestId, ...data }, { jobId, removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: "exponential", delay: 30000 }, ignoreDependencyOnFailure: true });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}

export async function enqueueLabour(input: ModelInput, resumeAt = 0, requestId = randomUUID()) {
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
  const existingQueueJobs = await extractionQueue.getJobs(["active", "waiting", "delayed", "paused"], 0, -1, true);
  const existingCancellation = await redis.exists(cancellationKey(requestId));
  if (existingCancellation) throw new Error("This labour request is being cancelled and cannot be re-enqueued");
  if (existingQueueJobs.some(existing => String(existing.data.requestId) === requestId)) throw new Error("Extraction already has a queued or active job");
  const initial: JobState = {
    requestId, resource: "labours", status: "queued", stage: "queued", progress: 0, input: { manufacturer: input.manufacturer, series: entries[0]?.series, model: input.model ?? entries[0]?.model, family: entries[0]?.family ?? "", axCode: input.axCode, edition: input.edition ?? input.date, date: input.date, typekeys: entries.map(entry => entry.typekey), group: "BMW", language: input.language },
    extractionSummary: { typekeys: entries.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })), date: input.date, axCode: input.axCode },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveState(initial);
  try {
    const runId = randomUUID();
    await queueJob(extractionQueue, "extract", requestId, { input, index: resumeAt, runId, resource: "labours", replacementAttempt }, extractionJobId(requestId, runId, resumeAt));
  } catch (error) {
    await redis.del(stateKey(requestId));
    throw error;
  }
  return requestId;
}

export async function processModel(job: Job) {
  const { requestId, input, index, runId: jobRunId, resource: jobResource } = job.data as { requestId: string; input: ModelInput; index: number; chunk?: number; runId?: string; resource?: "models" | "labours" };
  return metricRequestContext.run(requestId, () => processTypekeyJob(job, requestId, input, index, jobRunId, jobResource, Boolean(job.data.replacementAttempt)));
}

async function processTypekeyJob(job: Job, requestId: string, input: ModelInput, index: number, jobRunId?: string, jobResource?: "models" | "labours", replacementAttempt = false) {
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
  const typekeyInput: ExtractionInput = { manufacturer: input.manufacturer, series, model: model ?? "", family: entry.family, axCode: input.axCode, edition: input.edition ?? input.date, typekeys: [entry.typekey], group: "BMW", language: input.language };
  const resource = jobResource ?? (await state(requestId))?.resource ?? "labours";
  const typekeyStartedAt = Date.now();
  let currentHgs = 0;
  const heartbeatTimer = setInterval(() => {
    void redis.set(`bmw-reader:job:${requestId}:heartbeat`, JSON.stringify({ at: Date.now(), runId }), "PX", 30000);
  }, 5000);
  heartbeatTimer.unref?.();
  await redis.set(`bmw-reader:job:${requestId}:heartbeat`, JSON.stringify({ at: Date.now(), runId }), "PX", 30000);
  const controller = new AbortController();
  activeCancellation.set(requestId, controller);
  const cancelPoll = setInterval(() => {
    void redis.exists(cancellationKey(requestId)).then(exists => { if (exists) controller.abort(); }).catch(error => console.warn(JSON.stringify({ event: "cancel_flag_poll_failed", requestId, error: error instanceof Error ? error.message : String(error) })));
  }, 500);
  cancelPoll.unref?.();
  try {
    if (await redis.exists(cancellationKey(requestId))) controller.abort();
    const legacyPending = await extractionQueue.getJobs(["waiting", "delayed"], 0, -1, true);
    for (const legacy of legacyPending) {
      if (String(legacy.data.requestId) !== requestId || String(legacy.data.runId ?? "") === runId) continue;
      try { await legacy.remove(); }
      catch (error) { console.warn(JSON.stringify({ event: "legacy_chunk_cleanup_failed", requestId, jobId: legacy.id, error: error instanceof Error ? error.message : String(error) })); }
    }
    await updateState(requestId, { status: "downloading", resource, stage: `${entry.typekey}:preparing` });
    console.info(JSON.stringify({ event: "typekey_started", requestId, typekey: entry.typekey, index }));
    const client = new BmwClient(input.language, undefined, async event => {
      if (event.recovered) {
        const current = await state(requestId);
        if (current) await saveState({ ...current, status: "downloading", stage: `${entry.typekey}:resumed`, rateLimitInfo: undefined });
        return;
      }
      const retryAt = new Date(Date.now() + event.cooldownMs).toISOString();
      const current = await state(requestId);
    if (current) await saveState({
        ...current,
        status: event.cooldownMs > config.BMW_RATE_LIMIT_STATE_THRESHOLD_MS ? "rate-limited" : current.status,
        stage: event.cooldownMs > config.BMW_RATE_LIMIT_STATE_THRESHOLD_MS ? `${entry.typekey}:rate-limited` : current.stage,
        rateLimitInfo: { count: event.count, cooldownUntil: retryAt, retryAfterMs: event.retryAfterMs },
      });
    }, requestId, controller.signal);
    await redis.sadd(`bmw-reader:job:${requestId}:typekeys`, entry.typekey);
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
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, series, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0, failedOids: 0 }];
    if (index + 1 < input.typekeys.length) {
      await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
      await queueJob(extractionQueue, "extract", requestId, { input, index: index + 1, runId, resource }, extractionJobId(requestId, runId, index + 1));
      return { kind: "typekey", requestId, typekey: entry.typekey, nextTypekey: input.typekeys[index + 1]!.typekey };
    }
    return await finishModel(requestId, input, summaries);
  } catch (error) {
    if (error instanceof BmwRequestCancelledError || controller.signal.aborted || await redis.exists(cancellationKey(requestId))) {
      const current = await state(requestId);
      if (current) await finalizeCancelledJob(requestId, current);
      return { kind: "cancelled", requestId, typekey: entry.typekey };
    }
    const retryWindowExhausted = error instanceof Error && "retryWindowExhausted" in error && error.retryWindowExhausted === true;
    const deferredFailuresFinal = error instanceof Error && error.name === "TypekeyOidFailures";
    const outageAbort = error instanceof Error && error.message.includes("BMW appears unavailable after 3 consecutive OID failures");
    const discard = retryWindowExhausted || deferredFailuresFinal || outageAbort;
    if (discard) job.discard();
    const retrying = !discard && job.attemptsMade + 1 < Number(job.opts.attempts ?? 1);
    const lastState = await state(requestId);
    await updateState(requestId, { status: retrying ? "queued" : "failed", stage: retrying ? `${entry.typekey}:retrying` : "failed", progress: lastState?.progress ?? null, error: error instanceof Error ? error.message : String(error) });
    console.error(JSON.stringify({ event: retrying ? "typekey_attempt_failed" : "typekey_failed", requestId, typekey: entry.typekey, attempt: job.attemptsMade + 1, willRetry: retrying, error: error instanceof Error ? error.message : String(error) }));
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cancelPoll);
    if (activeCancellation.get(requestId) === controller) activeCancellation.delete(requestId);
    const heartbeat = await redis.get(`bmw-reader:job:${requestId}:heartbeat`);
    if (heartbeat && JSON.parse(heartbeat).runId === runId) await redis.del(`bmw-reader:job:${requestId}:heartbeat`);
  }
}

async function finishModel(requestId: string, input: ModelInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  const startedAt = Date.parse((await state(requestId))?.createdAt ?? new Date().toISOString());
    const resource = (await state(requestId))?.resource ?? "labours";
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, resource, error: undefined, rateLimitInfo: undefined, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
  await redis.srem(pausedJobsKey, requestId);
  const durationMs = Date.now() - startedAt;
  console.info(JSON.stringify({ event: "extraction_completed", requestId, durationMs }));
  return { kind: "extraction", requestId, durationMs };
}

export function createExtractionWorker() {
  activeWorker = new Worker("bmw-extractions", processModel, {
    ...connection, concurrency: config.JOB_CONCURRENCY, stalledInterval: 15000, lockDuration: 60000, maxStalledCount: 100,
    settings: { backoffStrategy: attemptsMade => Math.min(30000 * 2 ** attemptsMade, 300000) },
  });
  return activeWorker;
}

export async function resumeLabour(requestId: string, force = false, startupRecovery = false) {
  const current = await state(requestId);
  if (!current || !["models", "labours"].includes(current.resource ?? "") || !current.input || !current.extractionSummary) throw new Error("Resumable extraction not found");
  if (current.status === "cancelled" || current.status === "cancelling") throw new Error("Cancelled extractions cannot be resumed");
  const heartbeat = await redis.pttl(`bmw-reader:job:${requestId}:heartbeat`);
  if (force && !startupRecovery && !workerShuttingDown && await redis.get("bmw-reader:worker:singleton")) throw new Error("Force resume is disabled while a worker is active");
  if (!["failed", "downloading", "queued", "paused", "rate-limited"].includes(current.status)) throw new Error(`Extraction is not resumable (current status: ${current.status})`);
  if (heartbeat > 0 && !force && !startupRecovery && current.status === "downloading") throw new Error("Extraction is currently active");
  const recoveredJobs = await extractionQueue.getJobs(["active", "waiting", "delayed", "paused", "failed"], 0, -1, true);
  for (const existing of recoveredJobs) {
    if (String(existing.data.requestId) !== requestId) continue;
    if (existing.id?.includes("--")) continue;
    if (await existing.getState() === "active") throw new Error("Extraction has an active legacy job; wait for it to finish before resuming");
    try { await existing.remove(); } catch { /* active/locked legacy jobs are left for BullMQ recovery */ }
  }
  if (!force) {
    const existing = await extractionQueue.getJobs(["active", "waiting", "delayed"], 0, -1, true);
    if (existing.some(job => String(job.data.requestId) === requestId)) throw new Error("Extraction already has a queued or active job");
  }
  const savedInput = current.input as ExtractionInput;
  const entries = current.extractionSummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) }));
  const modelInput: ModelInput = {
    manufacturer: savedInput.manufacturer, model: savedInput.model, axCode: savedInput.axCode,
    edition: savedInput.edition, date: current.extractionSummary.date,
    language: savedInput.language, typekeys: entries,
  };
  const runId = randomUUID();
  const summary = current.extractionSummary.typekeys;
  const resumeAt = resumableTypekeyIndex(entries, summary);
  const jobId = extractionJobId(requestId, runId, resumeAt);
  await saveState({ ...current, resource: "labours", status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined });
  await redis.srem(pausedJobsKey, requestId);
  try {
    await queueJob(extractionQueue, "extract", requestId, { input: modelInput, index: resumeAt, runId, resource: "labours", replacementAttempt: true }, jobId);
  } catch (error) {
    await saveState(current);
    throw error;
  }
  return { requestId, resumedAtTypekey: entries[resumeAt]?.typekey ?? entries[0]?.typekey, queue: "bmw-extractions" };
}

export async function resumePausedJobs() {
  const liveQueueJobs = await extractionQueue.getJobs(["active", "waiting", "delayed", "paused"], 0, -1, true);
  const liveRequestIds = new Set(liveQueueJobs.map(job => String(job.data.requestId)));
  const requestIds = new Set(await redis.smembers(pausedJobsKey));
  const resumed = new Set(liveRequestIds);
  const stream = redis.scanStream({ match: "bmw-reader:job:*", count: 100 });
  for await (const keys of stream) {
    for (const key of keys as string[]) {
      if (key.endsWith(":heartbeat") || key.endsWith(":typekeys")) continue;
      const requestId = key.slice("bmw-reader:job:".length);
      const current = await state(requestId);
    if (current && ["downloading", "queued", "rate-limited", "paused"].includes(current.status)) requestIds.add(requestId);
    }
  }
  for (const requestId of requestIds) {
    const current = await state(requestId);
    if (!current || !laboursToRecover([{ requestId, status: current.status }], resumed).length) continue;
    try { await resumeLabour(requestId, false, true); resumed.add(requestId); }
    catch (error) { console.warn(JSON.stringify({ event: "orphan_job_resume_skipped", requestId, error: error instanceof Error ? error.message : String(error) })); }
  }
  return resumed.size - liveRequestIds.size;
}

export async function recoverCancelledLabours() {
  let recovered = 0;
  const activeJobs = await extractionQueue.getJobs(["active"], 0, -1, true);
  const activeRequestIds = new Set(activeJobs.map(job => String(job.data.requestId)));
  for (const requestId of await cancellationRecoveryCandidates()) {
    if (activeRequestIds.has(requestId)) continue;
    const current = await state(requestId);
    if (!current || current.status !== "cancelling") continue;
    const active = (await extractionQueue.getJobs(["active"], 0, -1, true)).some(job => String(job.data.requestId) === requestId);
    if (!active) {
      await finalizeCancelledJob(requestId, current);
      recovered++;
    }
  }
  return recovered;
}

export function laboursToRecover(states: Array<{ requestId: string; status: JobState["status"] }>, liveRequestIds: Set<string>) {
  return states.filter(item => ["downloading", "queued", "rate-limited", "paused"].includes(item.status) && !liveRequestIds.has(item.requestId)).map(item => item.requestId);
}

export async function migrateLegacyQueueJobs() {
  const legacyQueues = [new Queue("bmw-models", connection), new Queue("bmw-labours", connection)];
  let migrated = 0;
  try {
    for (const legacyQueue of legacyQueues) {
      const counts = await legacyQueue.getJobCounts("waiting", "delayed", "failed");
      const lists = await Promise.all((Object.entries(counts) as Array<[string, number]>).map(async ([queueState, count]) =>
        count > 0 ? legacyQueue.getJobs([queueState as "active" | "waiting" | "delayed" | "failed"], 0, -1, true) : [],
      ));
      const jobs = lists.flat();
      for (const legacyJob of jobs) {
        const requestId = String(legacyJob.data.requestId ?? "");
        if (!requestId) continue;
        const stateValue = await state(requestId);
        if (!stateValue || stateValue.status === "completed") continue;
        const legacyLock = await redis.pttl(`bull:${legacyQueue.name}:${legacyJob.id}:lock`);
        const legacyWorker = await redis.pttl("bmw-reader:worker:heartbeat");
        if (legacyLock > 0) continue;
        if (stateValue.status === "downloading" && legacyWorker > 0) {
          const legacyWorkerLock = await redis.get("bmw-reader:worker:singleton");
          if (legacyWorkerLock) continue;
        }
        const sourceInput = legacyJob.data.input as ModelInput | undefined;
        if (!sourceInput || !Array.isArray(sourceInput.typekeys)) continue;
        const index = Number.isInteger(legacyJob.data.index) ? legacyJob.data.index as number : 0;
        const resource = "labours";
        const runId = randomUUID();
        const newJobId = extractionJobId(requestId, runId, index);
        await queueJob(extractionQueue, "extract", requestId, { input: sourceInput, index, runId, resource }, newJobId);
        await saveState({ ...stateValue, resource: "labours", status: "queued", stage: "migrated-to-shared-queue", error: undefined });
        await legacyJob.remove();
        migrated++;
        console.info(JSON.stringify({ event: "legacy_job_migrated", requestId, queue: legacyQueue.name, newQueue: extractionQueue.name, typekey: sourceInput.typekeys[index]?.typekey }));
      }
    }
  } finally {
    await Promise.all(legacyQueues.map(queue => queue.close()));
  }
  return migrated;
}

export async function workerLiveness() {
  const [heartbeat, ttl, queueCounts, activeJobs] = await Promise.all([
    redis.get("bmw-reader:worker:heartbeat"), redis.pttl("bmw-reader:worker:heartbeat"),
    extractionQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed"), extractionQueue.getJobs(["active"], 0, -1, true),
  ]);
  return { alive: ttl > 0, concurrency: config.JOB_CONCURRENCY, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: "bmw-extractions", queueCounts, activeJobs: activeJobs.map(job => ({ requestId: String(job.data.requestId), typekey: (job.data.input as ModelInput | undefined)?.typekeys?.[Number(job.data.index)]?.typekey })) };
}

export async function isLabourStalled(requestId: string, currentState?: JobState) {
  const current = currentState ?? await state(requestId);
  if (!current || current.status === "cancelled" || current.status === "cancelling" || !["downloading", "queued", "rate-limited"].includes(current.status)) return false;
  if (await redis.pttl(`bmw-reader:job:${requestId}:heartbeat`) > 0) return false;
  const [active, pending] = await Promise.all([
    extractionQueue.getJobs(["active"], 0, -1, true),
    extractionQueue.getJobs(["waiting", "delayed", "paused"], 0, -1, true),
  ]);
  const jobs = [...active, ...pending];
  if (jobs.some(job => String(job.data.requestId) === requestId)) return false;
  return true;
}

export async function logBmwMetricsMinute(): Promise<void> {
  await logBmwMetricsMinuteGlobal();
}

export async function labourThroughput(requestId: string) {
  return getBmwMetrics(requestId, 5);
}

export async function startMetricsLogger() {
  const timer = setInterval(() => { void logBmwMetricsMinute(); }, 15000);
  timer.unref?.();
  await logBmwMetricsMinute();
  return () => clearInterval(timer);
}
