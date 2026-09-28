import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { BmwClient } from "./bmw/client.js";
import { fetchTypekey } from "./bmw/fetch-typekey.js";
import { getJson, getJsonIfExists, objectKey, putJson, signedDownload } from "./storage.js";
import type { ExtractionInput, JobState } from "./types.js";

const connection = { connection: redis };
export const extractionQueue = new Queue("bmw-extractions", connection);
const stateKey = (id: string) => `bmw-reader:job:${id}`;
let workerShuttingDown = false;
let activeWorker: Worker | undefined;
const pausedJobsKey = "bmw-reader:paused-jobs";
export function setWorkerShuttingDown(value: boolean) {
  workerShuttingDown = value;
  if (value) void activeWorker?.pause(true);
}
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
  await queue.add(name, { requestId, ...data }, { jobId, removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: "exponential", delay: 30000 } });
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
  const initial: JobState = {
    requestId, resource, status: "queued", stage: "queued", progress: 0, input: { manufacturer: input.manufacturer, model: input.model ?? input.typekeys[0]?.model ?? "", family: input.typekeys[0]?.family ?? "", axCode: input.axCode, edition: input.edition ?? input.date, typekeys: input.typekeys.map(entry => entry.typekey), group: "BMW", language: input.language },
    extractionSummary: { typekeys: input.typekeys.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })), date: input.date, axCode: input.axCode },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveState(initial);
  try {
    await queueJob(extractionQueue, "extract", requestId, { input, index: resumeAt, chunk: 0, resource }, `${requestId}:${resumeAt}:0`);
  } catch (error) {
    await redis.del(stateKey(requestId));
    throw error;
  }
  return requestId;
}

function prefixFor(input: ExtractionInput, typekey: string, date: string) {
  return objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, date, typekey);
}
async function typekeyProgress(input: ExtractionInput, typekey: string, date: string) {
  const root = prefixFor(input, typekey, date);
  const markersPrefix = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, date, "_progress", typekey);
  const catalog = await getJson<Array<{ number?: string }>>(`${root}/${typekey}_catalog.json`);
  const manifest = await getJson<Record<string, { groups: string[] }>>(`${root}/${typekey}_awSheetOIDsAndGroups.json`);
  let completed: Set<string>;
  const checkpoint = await getJsonIfExists<{ completedOids?: unknown }>(`${markersPrefix}/_state.json`);
  if (checkpoint && Array.isArray(checkpoint.completedOids) && !checkpoint.completedOids.some(oid => typeof oid !== "string")) {
    completed = new Set(checkpoint.completedOids as string[]);
  } else {
    const markers = await (await import("./storage.js")).listObjectKeys(`${markersPrefix}/`);
    completed = new Set(markers.filter(key => !key.endsWith("/_state.json")).map(key => key.slice(markersPrefix.length + 1).replace(/\.json$/, "")));
    await putJson(`${markersPrefix}/_state.json`, { typekey, total: Object.keys(manifest).length, completedOids: [...completed].filter(oid => Object.hasOwn(manifest, oid)), updatedAt: new Date().toISOString() });
  }
  const total = Object.keys(manifest).length;
  const completedCount = Object.keys(manifest).filter(oid => completed.has(oid)).length;
  const hgs = [...new Set(catalog.map(row => String(row.number ?? "")).filter(Boolean))];
  return { root, catalog, manifest, hgs, completed, completedCount, total };
}

async function alreadyComplete(input: ExtractionInput, typekey: string, date: string) {
  try {
    const progress = await typekeyProgress(input, typekey, date);
    return progress.hgs.length > 0 && progress.completedCount === progress.total && progress.total > 0;
  } catch { return false; }
}

export async function processModel(job: Job) {
  const { requestId, input, index, chunk, resource: jobResource } = job.data as { requestId: string; input: ModelInput; index: number; chunk: number; resource?: "models" | "labours" };
  const entry = input.typekeys[index];
  if (!entry) throw new Error(`Missing model typekey at index ${index}`);
  const model = entry.model ?? input.model;
  if (!model) throw new Error(`Model is required for typekey ${entry.typekey}`);
  const extractionModel = model.replace(/'/g, "");
  const typekeyInput: ExtractionInput = { manufacturer: input.manufacturer, model: extractionModel, family: entry.family, axCode: input.axCode, edition: input.edition ?? input.date, typekeys: [entry.typekey], group: "BMW", language: input.language };
  const resource = jobResource ?? (await state(requestId))?.resource ?? "models";
  const heartbeatTimer = setInterval(() => {
    void redis.set(`bmw-reader:job:${requestId}:heartbeat`, String(Date.now()), "PX", 30000);
  }, 5000);
  heartbeatTimer.unref?.();
  try {
    await updateState(requestId, { status: "downloading", resource, stage: `${entry.typekey}:preparing` });
    if (await alreadyComplete(typekeyInput, entry.typekey, input.date)) {
      const p = await typekeyProgress(typekeyInput, entry.typekey, input.date);
      const summary = { typekey: entry.typekey, family: entry.family, model, hgs: p.hgs.length, awSheetOIDs: p.total, completedAwSheetOIDs: p.completedCount, remainingAwSheetOIDs: 0 };
      const current = await state(requestId);
      const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), summary];
      if (index + 1 < input.typekeys.length) {
        await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
        const next = input.typekeys[index + 1]!;
        await queueJob(extractionQueue, "extract", requestId, { input, index: index + 1, chunk: 0, resource }, `${requestId}:${index + 1}:0`);
        return { requestId, completedTypekey: entry.typekey, nextTypekey: next.typekey };
      }
      return await finishModel(requestId, input, summaries);
    }
    const cachedProgress = await typekeyProgress(typekeyInput, entry.typekey, input.date).catch(() => undefined);
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
    });
    const result = await fetchTypekey(client, typekeyInput, entry.typekey, requestId, baseExtractionDate(input.date), async event => {
      if (event.stage !== "aw-sheet-details") await updateState(requestId, { status: "downloading", rateLimitInfo: undefined });
      const completed = event.stage === "aw-sheet-details" ? event.completed : cachedProgress?.completedCount ?? 0;
      const total = event.stage === "aw-sheet-details" ? event.total : cachedProgress?.total ?? 0;
      const current = await state(requestId);
      const existing = current?.extractionSummary?.typekeys ?? [];
      const summary = { typekey: entry.typekey, family: entry.family, model, hgs: cachedProgress?.hgs.length ?? 0, awSheetOIDs: total, completedAwSheetOIDs: completed, remainingAwSheetOIDs: Math.max(0, total - completed) };
      await updateState(requestId, { stage: `${entry.typekey}:${event.stage}`, progress: Math.min(99, Math.floor(index / input.typekeys.length * 100 + (total ? completed / total : 0) * (100 / input.typekeys.length))), extractionSummary: { typekeys: [...existing.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode } });
    }, true, config.BMW_AW_SHEET_CHUNK_SIZE);
    if (result.remainingAwSheetOIDs > 0) {
      if (workerShuttingDown) {
        const current = await state(requestId);
        const completedTypekeys = current?.extractionSummary?.typekeys ?? [];
        const currentTypekey = { typekey: entry.typekey, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: result.remainingAwSheetOIDs };
        await updateState(requestId, { status: "paused", stage: `${entry.typekey}:paused`, extractionSummary: { typekeys: [...completedTypekeys.filter(item => item.typekey !== entry.typekey), currentTypekey], date: input.date, axCode: input.axCode } });
        await redis.sadd(pausedJobsKey, requestId);
        return { requestId, paused: true, remaining: result.remainingAwSheetOIDs };
      }
      if (chunk === 0 && index === 0) {
        await updateState(requestId, { stage: `${entry.typekey}:aw-sheet-resume:${chunk + 1}` });
      }
      await queueJob(extractionQueue, "extract", requestId, { input, index, chunk: chunk + 1, resource }, `${requestId}:${index}:${chunk + 1}`);
      return { requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }
    const current = await state(requestId);
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0 }];
    if (index + 1 < input.typekeys.length) {
      await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
      await queueJob(extractionQueue, "extract", requestId, { input, index: index + 1, chunk: 0, resource }, `${requestId}:${index + 1}:0`);
      return { requestId, completedTypekey: entry.typekey };
    }
    return finishModel(requestId, input, summaries);
  } catch (error) {
    const retrying = job.attemptsMade + 1 < Number(job.opts.attempts ?? 1);
    await updateState(requestId, { status: retrying ? "queued" : "failed", stage: retrying ? `${entry.typekey}:retrying` : "failed", progress: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function finishModel(requestId: string, input: ModelInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  const modelName = (input.model ?? input.typekeys[0]?.model)?.replace(/'/g, "") ?? "multiple-models";
  const summaryKey = objectKey("BMW", input.manufacturer, "labour", modelName, input.typekeys[0]?.family ?? "unknown", input.date, "structured", `model_${input.axCode ?? "without-axcode"}_${input.date}.json`);
  await putJson(summaryKey, { ...input, typekeys: summaries, completedAt: new Date().toISOString() });
  const resource = (await state(requestId))?.resource ?? "models";
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, resource, s3Path: summaryKey, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
  await redis.srem(pausedJobsKey, requestId);
  return { requestId, summaryKey };
}

export function createExtractionWorker() {
  activeWorker = new Worker("bmw-extractions", processModel, {
    ...connection, concurrency: 1, stalledInterval: 15000, lockDuration: 60000, maxStalledCount: 100,
    settings: { backoffStrategy: attemptsMade => Math.min(30000 * 2 ** attemptsMade, 300000) },
  });
  return activeWorker;
}

export async function resumeModel(requestId: string, force = false) {
  const current = await state(requestId);
  if (!current || !["models", "labours"].includes(current.resource ?? "") || !current.input || !current.extractionSummary) throw new Error("Resumable extraction not found");
  const heartbeat = current.resource === "models" ? await redis.pttl(`bmw-reader:job:${requestId}:heartbeat`) : -2;
  if (!["failed", "downloading", "queued", "paused", "rate-limited"].includes(current.status)) throw new Error(`Extraction is not resumable (current status: ${current.status})`);
  if (heartbeat > 0 && !force) throw new Error("Extraction is currently active");
  if (force && await redis.get("bmw-reader:worker:singleton")) throw new Error("Stop the active worker before force-resuming an extraction");
  if (current.status === "queued" && !force) {
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
  const jobId = `${requestId}:resume:${Date.now()}`;
  const summary = current.extractionSummary.typekeys;
  const summaryByTypekey = new Map(summary.map(item => [item.typekey, item]));
  const pendingAt = entries.findIndex(entry => {
    const item = summaryByTypekey.get(entry.typekey);
    return !item || item.awSheetOIDs === 0 || item.remainingAwSheetOIDs > 0;
  });
  const resumeAt = pendingAt < 0 ? 0 : pendingAt;
  await saveState({ ...current, status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined });
  await redis.srem(pausedJobsKey, requestId);
  try {
    await queueJob(extractionQueue, "extract", requestId, { input: modelInput, index: resumeAt, chunk: 0, resource: current.resource }, jobId);
  } catch (error) {
    await saveState(current);
    throw error;
  }
  return { requestId, resumedAtTypekey: entries[resumeAt]?.typekey ?? entries[0]?.typekey, queue: "bmw-extractions" };
}

export async function resumePausedJobs() {
  const requestIds = await redis.smembers(pausedJobsKey);
  const liveQueueJobs = await extractionQueue.getJobs(["active", "waiting", "delayed"], 0, -1, true);
  const liveRequestIds = new Set(liveQueueJobs.map(job => String(job.data.requestId)));
  for (const requestId of requestIds) {
    const current = await state(requestId);
    if (current?.status !== "paused" || liveRequestIds.has(requestId)) continue;
    try { await resumeModel(requestId); }
    catch (error) { console.warn(JSON.stringify({ event: "paused_job_resume_skipped", requestId, error: error instanceof Error ? error.message : String(error) })); }
  }
  return requestIds.length;
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
        const chunk = Number.isInteger(legacyJob.data.chunk) ? legacyJob.data.chunk as number : 0;
        const resource = stateValue.resource === "labours" || legacyQueue.name === "bmw-labours" ? "labours" : "models";
        const newJobId = `${requestId}:migrated:${Date.now()}:${migrated}`;
        await queueJob(extractionQueue, "extract", requestId, { input: sourceInput, index, chunk, resource }, newJobId);
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
  const heartbeat = await redis.get("bmw-reader:worker:heartbeat");
  const ttl = await redis.pttl("bmw-reader:worker:heartbeat");
  const queueCounts = await extractionQueue.getJobCounts("active", "waiting", "delayed", "failed", "completed");
  return { alive: ttl > 0, heartbeat: heartbeat ? new Date(Number(heartbeat)).toISOString() : null, ttlMs: ttl > 0 ? ttl : null, queue: "bmw-extractions", queueCounts };
}
