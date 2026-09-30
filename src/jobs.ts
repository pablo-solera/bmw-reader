import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { metricRequestContext } from "./metrics-context.js";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { BmwClient } from "./bmw/client.js";
import { fetchTypekey } from "./bmw/fetch-typekey.js";
import { objectKey, setS3PutObserver } from "./storage.js";
import { getBmwMetrics, logBmwMetricsMinute as logBmwMetricsMinuteGlobal, recordCompletedOid, recordS3PutLatency } from "./rate-metrics.js";
import type { ExtractionInput, JobState } from "./types.js";

const connection = { connection: redis };
export const extractionQueue = new Queue("bmw-extractions", connection);
const stateKey = (id: string) => `bmw-reader:job:${id}`;
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = "bmw-reader:paused-jobs";
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
async function saveState(value: JobState) {
  value.updatedAt = new Date().toISOString();
  await redis.set(stateKey(value.requestId), JSON.stringify(value), "EX", config.STATE_TTL_SECONDS);
}
async function updateState(id: string, patch: Partial<JobState>) {
  const current = await state(id);
  if (current) await saveState({ ...current, ...patch });
}

export type ModelInput = { axCode?: string; edition?: string; manufacturer: string; model?: string; date: string; typekeys: Array<{ typekey: string; family: string; model?: string }>; language?: string };

function validatePathSegment(field: string, value: string) {
  if (!/^[A-Za-z0-9 _.'-]+$/.test(value) || value === "." || value === "..") throw new Error(`${field} contains invalid path characters`);
}
function validateLabourInput(input: ExtractionInput) {
  validatePathSegment("manufacturer", input.manufacturer);
  validatePathSegment("model", input.model);
  validatePathSegment("family", input.family);
  if (!/^[A-Z0-9]{4}$/.test(input.typekeys[0] ?? "")) throw new Error("typekey must contain exactly four uppercase letters or digits");
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

export async function enqueueLabour(input: ExtractionInput) {
  validateLabourInput(input);
  if (input.typekeys.length !== 1) throw new Error("POST /labours accepts exactly one typekey");
  const typekey = input.typekeys[0]!;
  const modelInput: ModelInput = {
    manufacturer: input.manufacturer,
    model: input.model,
    date: input.edition,
    axCode: input.axCode,
    edition: input.edition,
    language: input.language,
    typekeys: [{ typekey, family: input.family, model: input.model }],
  };
  return enqueueModel(modelInput, "labours");
}

export async function getLabourOptions(typekey: string) {
  if (!/^[A-Z0-9]{4}$/.test(typekey)) throw new Error("typekey must contain exactly four uppercase letters or digits");
  const result = await new BmwClient().catalog(typekey);
  const catalog = Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
  return { typekey, catalogEntries: catalog.length, hg: [...new Set(catalog.map(row => String(row.number ?? "")).filter(Boolean))] };
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

export async function enqueueModel(input: ModelInput, resource: "models" | "labours" = "models", resumeAt = 0, requestId = randomUUID()) {
  validatePathSegment("manufacturer", input.manufacturer);
  if (input.model) validatePathSegment("model", input.model);
  if (input.axCode && !/^[A-Za-z0-9_]+$/.test(input.axCode)) throw new Error("axCode may only contain letters, digits and underscores");
  if (input.edition && !/^[A-Za-z0-9_]+$/.test(input.edition)) throw new Error("edition may only contain letters, digits and underscores");
  baseExtractionDate(input.date);
  if (!input.typekeys.length || input.typekeys.some(item => !/^[A-Z0-9]{4}$/.test(item.typekey) || !/^[A-Z0-9]+$/.test(item.family) || !/^[A-Za-z0-9 _.'-]+$/.test(item.model ?? input.model ?? ""))) throw new Error("Invalid model typekeys/families/models");
  if (new Set(input.typekeys.map(item => item.typekey)).size !== input.typekeys.length) throw new Error("Model typekeys must be unique");
  const previousState = await state(requestId);
  if (previousState) {
    if (resource !== "labours" || !new Set(["failed", "paused"]).has(previousState.status)) throw new Error(`Request ID already exists with status ${previousState.status}`);
    const completed = new Set((previousState.extractionSummary?.typekeys ?? []).filter(item => item.remainingAwSheetOIDs === 0 && item.awSheetOIDs > 0).map(item => item.typekey));
    const nextIndex = input.typekeys.findIndex(item => !completed.has(item.typekey));
    resumeAt = nextIndex < 0 ? input.typekeys.length - 1 : nextIndex;
  }
  const existingQueueJobs = await extractionQueue.getJobs(["active", "waiting", "delayed", "paused"], 0, -1, true);
  if (existingQueueJobs.some(existing => String(existing.data.requestId) === requestId)) throw new Error("Extraction already has a queued or active job");
  const initial: JobState = {
    requestId, resource, status: "queued", stage: "queued", progress: 0, input: { manufacturer: input.manufacturer, model: input.model ?? input.typekeys[0]?.model ?? "", family: input.typekeys[0]?.family ?? "", axCode: input.axCode, edition: input.edition ?? input.date, typekeys: input.typekeys.map(entry => entry.typekey), group: "BMW", language: input.language },
    extractionSummary: { typekeys: input.typekeys.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })), date: input.date, axCode: input.axCode },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveState(initial);
  try {
    const runId = randomUUID();
    await queueJob(extractionQueue, "extract", requestId, { input, index: resumeAt, runId, resource }, extractionJobId(requestId, runId, resumeAt));
  } catch (error) {
    await redis.del(stateKey(requestId));
    throw error;
  }
  return requestId;
}

export async function processModel(job: Job) {
  const { requestId, input, index, runId: jobRunId, resource: jobResource } = job.data as { requestId: string; input: ModelInput; index: number; chunk?: number; runId?: string; resource?: "models" | "labours" };
  return metricRequestContext.run(requestId, () => processTypekeyJob(job, requestId, input, index, jobRunId, jobResource));
}

async function processTypekeyJob(job: Job, requestId: string, input: ModelInput, index: number, jobRunId?: string, jobResource?: "models" | "labours") {
  const runId = jobRunId ?? randomUUID();
  const entry = input.typekeys[index];
  if (!entry) throw new Error(`Missing model typekey at index ${index}`);
  const model = entry.model ?? input.model;
  if (!model) throw new Error(`Model is required for typekey ${entry.typekey}`);
  const extractionModel = model.replace(/'/g, "");
  const typekeyInput: ExtractionInput = { manufacturer: input.manufacturer, model: extractionModel, family: entry.family, axCode: input.axCode, edition: input.edition ?? input.date, typekeys: [entry.typekey], group: "BMW", language: input.language };
  const resource = jobResource ?? (await state(requestId))?.resource ?? "models";
  const typekeyStartedAt = Date.now();
  let currentHgs = 0;
  const heartbeatTimer = setInterval(() => {
    void redis.set(`bmw-reader:job:${requestId}:heartbeat`, JSON.stringify({ at: Date.now(), runId }), "PX", 30000);
  }, 5000);
  heartbeatTimer.unref?.();
  await redis.set(`bmw-reader:job:${requestId}:heartbeat`, JSON.stringify({ at: Date.now(), runId }), "PX", 30000);
  try {
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
    }, requestId);
    await redis.sadd(`bmw-reader:job:${requestId}:typekeys`, entry.typekey);
      const result = await fetchTypekey(client, typekeyInput, entry.typekey, requestId, baseExtractionDate(input.date), async event => {
      if (event.stage !== "aw-sheet-details") await updateState(requestId, { status: "downloading", rateLimitInfo: undefined });
      const completed = event.completed;
      const total = event.total;
      const current = await state(requestId);
      const existing = current?.extractionSummary?.typekeys ?? [];
      currentHgs = event.hgs ?? currentHgs;
      const summary = { typekey: entry.typekey, family: entry.family, model, hgs: currentHgs, awSheetOIDs: total, completedAwSheetOIDs: completed, remainingAwSheetOIDs: Math.max(0, total - completed), failedOids: event.failed ?? 0 };
      const nextStatus = workerShuttingDown && event.stage === "aw-sheet-details" ? "paused" : "downloading";
      await updateState(requestId, { status: nextStatus, stage: nextStatus === "paused" ? `${entry.typekey}:pausing` : `${entry.typekey}:${event.stage}`, progress: Math.min(99, Math.floor(index / input.typekeys.length * 100 + (total ? completed / total : 0) * (100 / input.typekeys.length))), extractionSummary: { typekeys: [...existing.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode } });
      if (event.stage === "aw-sheet-details") console.info(JSON.stringify({ event: "typekey_progress", requestId, typekey: entry.typekey, completed, total, failed: event.failed ?? 0 }));
    }, true, () => workerShuttingDown);
    const current = await state(requestId);
    const summariesBefore = current?.extractionSummary?.typekeys ?? [];
    if (result.paused) {
      const pausedSummary = { typekey: entry.typekey, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: result.remainingAwSheetOIDs, failedOids: Object.keys(result.failedOids ?? {}).length };
      await updateState(requestId, { status: "paused", stage: `${entry.typekey}:paused`, extractionSummary: { typekeys: [...summariesBefore.filter(item => item.typekey !== entry.typekey), pausedSummary], date: input.date, axCode: input.axCode } });
      await redis.sadd(pausedJobsKey, requestId);
      console.info(JSON.stringify({ event: "extraction_paused", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs }));
      return { kind: "paused", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }
    console.info(JSON.stringify({ event: "typekey_completed", requestId, typekey: entry.typekey, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, durationMs: Date.now() - typekeyStartedAt }));
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0, failedOids: 0 }];
    if (index + 1 < input.typekeys.length) {
      await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
      await queueJob(extractionQueue, "extract", requestId, { input, index: index + 1, runId, resource }, extractionJobId(requestId, runId, index + 1));
      return { kind: "typekey", requestId, typekey: entry.typekey, nextTypekey: input.typekeys[index + 1]!.typekey };
    }
    return await finishModel(requestId, input, summaries);
  } catch (error) {
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
    const heartbeat = await redis.get(`bmw-reader:job:${requestId}:heartbeat`);
    if (heartbeat && JSON.parse(heartbeat).runId === runId) await redis.del(`bmw-reader:job:${requestId}:heartbeat`);
  }
}

async function finishModel(requestId: string, input: ModelInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  const startedAt = Date.parse((await state(requestId))?.createdAt ?? new Date().toISOString());
  const resource = (await state(requestId))?.resource ?? "models";
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, resource, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
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

export async function resumeModel(requestId: string, force = false, startupRecovery = false) {
  const current = await state(requestId);
  if (!current || !["models", "labours"].includes(current.resource ?? "") || !current.input || !current.extractionSummary) throw new Error("Resumable extraction not found");
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
  const entries = current.extractionSummary.typekeys.map(({ typekey, family, model }) => ({ typekey, family, ...(model ? { model } : {}) }));
  const modelInput: ModelInput = {
    manufacturer: savedInput.manufacturer, model: savedInput.model, axCode: savedInput.axCode,
    edition: savedInput.edition, date: current.extractionSummary.date,
    language: savedInput.language, typekeys: entries,
  };
  const runId = randomUUID();
  const summary = current.extractionSummary.typekeys;
  const summaryByTypekey = new Map(summary.map(item => [item.typekey, item]));
  const pendingAt = entries.findIndex(entry => {
    const item = summaryByTypekey.get(entry.typekey);
    return !item || item.awSheetOIDs === 0 || item.remainingAwSheetOIDs > 0;
  });
  const resumeAt = pendingAt < 0 ? 0 : pendingAt;
  const jobId = extractionJobId(requestId, runId, resumeAt);
  await saveState({ ...current, status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined });
  await redis.srem(pausedJobsKey, requestId);
  try {
    await queueJob(extractionQueue, "extract", requestId, { input: modelInput, index: resumeAt, runId, resource: current.resource }, jobId);
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
    if (!current || !["downloading", "queued", "rate-limited", "paused"].includes(current.status) || resumed.has(requestId)) continue;
    try { await resumeModel(requestId, false, true); resumed.add(requestId); }
    catch (error) { console.warn(JSON.stringify({ event: "orphan_job_resume_skipped", requestId, error: error instanceof Error ? error.message : String(error) })); }
  }
  return resumed.size - liveRequestIds.size;
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
        const resource = stateValue.resource === "labours" || legacyQueue.name === "bmw-labours" ? "labours" : "models";
        const runId = randomUUID();
        const newJobId = extractionJobId(requestId, runId, index);
        await queueJob(extractionQueue, "extract", requestId, { input: sourceInput, index, runId, resource }, newJobId);
        await saveState({ ...stateValue, status: "queued", stage: "migrated-to-shared-queue", error: undefined });
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
  return { alive: ttl > 0, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: "bmw-extractions", queueCounts, activeJobs: activeJobs.map(job => ({ requestId: String(job.data.requestId), typekey: (job.data.input as ModelInput | undefined)?.typekeys?.[Number(job.data.index)]?.typekey })) };
}

export async function isModelStalled(requestId: string, currentState?: JobState) {
  const current = currentState ?? await state(requestId);
  if (!current || !["downloading", "queued", "rate-limited"].includes(current.status)) return false;
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

export async function modelThroughput(requestId: string) {
  return getBmwMetrics(requestId, 5);
}

export async function startMetricsLogger() {
  const timer = setInterval(() => { void logBmwMetricsMinute(); }, 15000);
  timer.unref?.();
  await logBmwMetricsMinute();
  return () => clearInterval(timer);
}
