import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { BmwClient } from "./bmw/client.js";
import { fetchTypekey } from "./bmw/fetch-typekey.js";
import { getJson, getJsonIfExists, objectKey, putJson, signedDownload } from "./storage.js";
import type { ExtractionInput, JobState } from "./types.js";

const connection = { connection: redis };
const labourQueue = new Queue("bmw-labours", connection);
const modelsQueue = new Queue("bmw-models", connection);
const stateKey = (id: string) => `bmw-reader:job:${id}`;
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
  await queue.add(name, { requestId, ...data }, { jobId, removeOnComplete: true, removeOnFail: 100, attempts: 4, backoff: { type: "exponential", delay: 3000 } });
}

export async function enqueueLabour(input: ExtractionInput) {
  validateLabourInput(input);
  if (input.typekeys.length !== 1) throw new Error("POST /labours accepts exactly one typekey");
  const requestId = randomUUID();
  const initial: JobState = { requestId, resource: "labours", status: "queued", stage: "queued", progress: 0, input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveState(initial);
  await queueJob(labourQueue, "labour", requestId, { input, chunk: 0 }, `${requestId}:0`);
  return requestId;
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

export async function enqueueModel(input: ModelInput) {
  validatePathSegment("manufacturer", input.manufacturer);
  if (input.model) validatePathSegment("model", input.model);
  if (input.axCode && !/^[A-Za-z0-9_]+$/.test(input.axCode)) throw new Error("axCode may only contain letters, digits and underscores");
  if (input.edition && !/^[A-Za-z0-9_]+$/.test(input.edition)) throw new Error("edition may only contain letters, digits and underscores");
  baseExtractionDate(input.date);
  if (!input.typekeys.length || input.typekeys.some(item => !/^[A-Z0-9]{4}$/.test(item.typekey) || !/^[A-Z0-9]+$/.test(item.family) || !/^[A-Za-z0-9 _.'-]+$/.test(item.model ?? input.model ?? ""))) throw new Error("Invalid model typekeys/families/models");
  if (new Set(input.typekeys.map(item => item.typekey)).size !== input.typekeys.length) throw new Error("Model typekeys must be unique");
  const requestId = randomUUID();
  const initial: JobState = {
    requestId, resource: "models", status: "queued", stage: "queued", progress: 0,
    extractionSummary: { typekeys: input.typekeys.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })), date: input.date, axCode: input.axCode },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveState(initial);
  await queueJob(modelsQueue, "model", requestId, { input, index: 0, chunk: 0 }, `${requestId}:0:0`);
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

async function queueLabourContinuation(requestId: string, input: ExtractionInput, chunk: number) {
  await queueJob(labourQueue, "labour", requestId, { input, chunk }, `${requestId}:${chunk}`);
}

export async function processLabour(job: Job) {
  const { requestId, input, chunk } = job.data as { requestId: string; input: ExtractionInput; chunk: number };
  const date = input.edition;
  const typekey = input.typekeys[0]!;
  try {
    await updateState(requestId, { status: "downloading", resource: "labours", input, stage: `${typekey}:preparing` });
    const progress = await typekeyProgress(input, typekey, date).catch(() => undefined);
    const result = await fetchTypekey(new BmwClient(input.language), input, typekey, requestId, baseExtractionDate(date), async event => {
      const currentProgress = event.stage === "aw-sheet-details" ? event.completed : progress?.completedCount ?? 0;
      const total = event.stage === "aw-sheet-details" ? event.total : progress?.total ?? 0;
      await updateState(requestId, { stage: `${typekey}:${event.stage}`, progress: total ? Math.floor(currentProgress / total * 100) : null, extractionSummary: { typekeys: [{ typekey, family: input.family, hgs: progress?.hgs.length ?? 0, awSheetOIDs: total, completedAwSheetOIDs: currentProgress, remainingAwSheetOIDs: Math.max(0, total - currentProgress) }], date, axCode: input.axCode } });
    }, true, 250);
    if (result.remainingAwSheetOIDs > 0) {
      await queueLabourContinuation(requestId, input, chunk + 1);
      return { requestId, typekey, remaining: result.remainingAwSheetOIDs };
    }
    const summaryKey = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, date, "structured", `${requestId}.json`);
    await putJson(summaryKey, { requestId, input, result: { typekey, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs }, completedAt: new Date().toISOString() });
    await updateState(requestId, { status: "completed", stage: "completed", progress: 100, input, s3Path: summaryKey, extractionSummary: { typekeys: [{ typekey, family: input.family, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.awSheetOIDs, remainingAwSheetOIDs: 0 }], date, axCode: input.axCode } });
    return { requestId, typekey, summaryKey };
  } catch (error) {
    const retrying = job.attemptsMade + 1 < Number(job.opts.attempts ?? 1);
    await updateState(requestId, { status: retrying ? "downloading" : "failed", stage: retrying ? `${typekey}:retrying` : "failed", progress: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function processModel(job: Job) {
  const { requestId, input, index, chunk } = job.data as { requestId: string; input: ModelInput; index: number; chunk: number };
  const entry = input.typekeys[index];
  if (!entry) throw new Error(`Missing model typekey at index ${index}`);
  const model = entry.model ?? input.model;
  if (!model) throw new Error(`Model is required for typekey ${entry.typekey}`);
  const extractionModel = model.replace(/'/g, "");
  const typekeyInput: ExtractionInput = { manufacturer: input.manufacturer, model: extractionModel, family: entry.family, axCode: input.axCode, edition: input.edition ?? input.date, typekeys: [entry.typekey], group: "BMW", language: input.language };
  try {
    await updateState(requestId, { status: "downloading", resource: "models", stage: `${entry.typekey}:preparing` });
    if (await alreadyComplete(typekeyInput, entry.typekey, input.date)) {
      const p = await typekeyProgress(typekeyInput, entry.typekey, input.date);
      const summary = { typekey: entry.typekey, family: entry.family, model, hgs: p.hgs.length, awSheetOIDs: p.total, completedAwSheetOIDs: p.completedCount, remainingAwSheetOIDs: 0 };
      const current = await state(requestId);
      const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), summary];
      if (index + 1 < input.typekeys.length) {
        await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
        const next = input.typekeys[index + 1]!;
      await queueJob(modelsQueue, "model", requestId, { input, index: index + 1, chunk: 0 }, `${requestId}:${index + 1}:0`);
        return { requestId, completedTypekey: entry.typekey, nextTypekey: next.typekey };
      }
      return await finishModel(requestId, input, summaries);
    }
    const cachedProgress = await typekeyProgress(typekeyInput, entry.typekey, input.date).catch(() => undefined);
    const result = await fetchTypekey(new BmwClient(input.language), typekeyInput, entry.typekey, requestId, baseExtractionDate(input.date), async event => {
      const completed = event.stage === "aw-sheet-details" ? event.completed : cachedProgress?.completedCount ?? 0;
      const total = event.stage === "aw-sheet-details" ? event.total : cachedProgress?.total ?? 0;
      const current = await state(requestId);
      const existing = current?.extractionSummary?.typekeys ?? [];
      const summary = { typekey: entry.typekey, family: entry.family, model, hgs: cachedProgress?.hgs.length ?? 0, awSheetOIDs: total, completedAwSheetOIDs: completed, remainingAwSheetOIDs: Math.max(0, total - completed) };
      await updateState(requestId, { stage: `${entry.typekey}:${event.stage}`, progress: Math.min(99, Math.floor(index / input.typekeys.length * 100 + (total ? completed / total : 0) * (100 / input.typekeys.length))), extractionSummary: { typekeys: [...existing.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode } });
    }, true, 250);
    if (result.remainingAwSheetOIDs > 0) {
      await updateState(requestId, { stage: `${entry.typekey}:aw-sheet-resume:${chunk + 1}` });
      await queueJob(modelsQueue, "model", requestId, { input, index, chunk: chunk + 1 }, `${requestId}:${index}:${chunk + 1}`);
      return { requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }
    const current = await state(requestId);
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, family: entry.family, model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0 }];
    if (index + 1 < input.typekeys.length) {
      await updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
      await queueJob(modelsQueue, "model", requestId, { input, index: index + 1, chunk: 0 }, `${requestId}:${index + 1}:0`);
      return { requestId, completedTypekey: entry.typekey };
    }
    return finishModel(requestId, input, summaries);
  } catch (error) {
    const retrying = job.attemptsMade + 1 < Number(job.opts.attempts ?? 1);
    await updateState(requestId, { status: retrying ? "downloading" : "failed", stage: retrying ? `${entry.typekey}:retrying` : "failed", progress: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function finishModel(requestId: string, input: ModelInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]) {
  const modelName = input.model?.replace(/'/g, "") ?? "multiple-models";
  const summaryKey = objectKey("BMW", input.manufacturer, "labour", modelName, input.date, "structured", `model_${input.axCode ?? "without-axcode"}_${input.date}.json`);
  await putJson(summaryKey, { ...input, typekeys: summaries, completedAt: new Date().toISOString() });
  await updateState(requestId, { status: "completed", stage: "completed", progress: 100, s3Path: summaryKey, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode } });
  return { requestId, summaryKey };
}

export function createLabourWorker() { return new Worker("bmw-labours", processLabour, { ...connection, concurrency: Math.max(1, config.JOB_CONCURRENCY) }); }
export function createModelWorker() { return new Worker("bmw-models", processModel, { ...connection, concurrency: 1 }); }
