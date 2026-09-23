import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { BmwClient } from "./bmw/client.js";
import { fetchTypekey, readRawTypekey } from "./bmw/fetch-typekey.js";
import { resolveDataRequest } from "./db/datarequest.js";
import { loadTypekeys, readDdaRows, readPivotRows, readRequestRows, recordPetition, savePivotSafe, writeSpecialDetails } from "./db/labour.js";
import { buildPivot, flattenFlatrates } from "./transform/flatrates.js";
import { flattenCatalog } from "./transform/catalog.js";
import { buildDdaWorkbook } from "./report/dda-excel.js";
import { objectKey, putBytes, putJson, signedDownload } from "./storage.js";
import type { ExtractionInput, JobState } from "./types.js";
import { normalizeOperation } from "./transform/dda.js";

const connection = { connection: redis };
export const extractionQueue = new Queue("bmw-extractions", connection);
const stateKey = (id: string) => `bmw-reader:job:${id}`;
export async function state(id: string): Promise<JobState | null> { const value = await redis.get(stateKey(id)); return value ? JSON.parse(value) as JobState : null; }
async function saveState(value: JobState) { value.updatedAt = new Date().toISOString(); await redis.set(stateKey(value.requestId), JSON.stringify(value), "EX", config.STATE_TTL_SECONDS); }
async function updateState(id: string, patch: Partial<JobState>) { const current = await state(id); if (!current) return; await saveState({ ...current, ...patch }); }

export async function enqueueExtraction(input: ExtractionInput | { dataRequestId: string }) {
  if ("dataRequestId" in input && (!input.dataRequestId || !/^\d+$/.test(input.dataRequestId))) throw new Error("dataRequestId must contain digits only");
  if ("typekeys" in input) {
    for (const [field, value] of Object.entries({ manufacturer: input.manufacturer, model: input.model, family: input.family, group: input.group ?? "BMW" })) {
      if (!/^[A-Za-z0-9 _.-]+$/.test(value) || value === "." || value === "..") throw new Error(`${field} contains invalid path characters`);
    }
    if (!/^[A-Za-z0-9_]+$/.test(input.axCode) || !/^[A-Za-z0-9_]+$/.test(input.edition)) throw new Error("axCode and edition must contain only letters, digits and underscores");
    if (input.typekeys.some(typekey => !/^[A-Z0-9]{4}$/.test(typekey))) throw new Error("Each typekey must contain exactly four uppercase letters or digits");
    if (new Set(input.typekeys).size !== input.typekeys.length) throw new Error("typekeys must be unique");
  }
  const dedupKey = `bmw-reader:lock:${inputFingerprint(input)}`;
  const requestId = randomUUID();
  const acquired = await redis.set(dedupKey, requestId, "EX", 600, "NX");
  if (acquired !== "OK") return (await redis.get(dedupKey)) ?? requestId;
  const jobState: JobState = { requestId, status: "queued", stage: "queued", progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    await saveState(jobState);
    await extractionQueue.add("extract", { requestId, input }, { jobId: requestId, removeOnComplete: true, removeOnFail: 100 });
    return requestId;
  } catch (error) {
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, dedupKey, requestId);
    throw error;
  }
}

function databasePivotIndex(rows: Array<Record<string, string | null>>, typekeys: string[]) {
  const result = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const operation = normalizeOperation(String(row.typekeyIdEntriesId_flatrates_number ?? ""));
    const values = result.get(operation) ?? new Map<string, string>();
    for (const typekey of typekeys) {
      const value = row[`type_${typekey}`];
      if (value != null && !values.has(typekey)) values.set(typekey, String(value).trim());
    }
    result.set(operation, values);
  }
  return result;
}
const inputFingerprint = (input: ExtractionInput | { dataRequestId: string }) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
async function releaseDedup(input: ExtractionInput | { dataRequestId: string }, requestId: string) {
  await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, `bmw-reader:lock:${inputFingerprint(input)}`, requestId);
}

export async function processExtraction(job: Job) {
  const { requestId, input: requestInput } = job.data as { requestId: string; input: ExtractionInput | { dataRequestId: string } };
  let input: ExtractionInput | undefined;
  let activeTypekey: string | undefined;
  try {
    await updateState(requestId, { status: "resolving", stage: "resolve-input", progress: 2 });
    const rawInput = requestInput as Partial<ExtractionInput> & { dataRequestId?: string };
    input = typeof rawInput.dataRequestId === "string" && !rawInput.typekeys
      ? await resolveDataRequest(rawInput.dataRequestId)
      : requestInput as ExtractionInput;
    if (input.dataRequestId) {
      const linked = await readRequestRows(input.dataRequestId);
      const first = linked.vehicles[0];
      if (first) {
        input.manufacturer = String(first.Manufacturer ?? input.manufacturer);
        input.model = String(first.Serie ?? input.model);
        input.family = String(first.DevelopmentCode ?? input.family);
        const vehicleKeys = new Set(linked.vehicles.map(row => String(row.typeKey ?? "")));
        input.typekeys = input.typekeys.filter(typekey => vehicleKeys.has(typekey));
      }
    }
    if (!input.typekeys?.length) throw new Error("At least one typekey is required");
    await updateState(requestId, { input, status: "downloading", stage: "download", progress: 5 });
    const client = new BmwClient(input.language);
    const childStates: Record<string, { requestId: string; status: string }> = {};
    const specialDetails: import("./db/labour.js").SpecialDetail[] = [];
    const extractionDate = new Date();
    for (const [index, typekey] of input.typekeys.entries()) {
      activeTypekey = typekey;
      childStates[typekey] = { requestId: `${requestId}:${typekey}`, status: "downloading" };
      await updateState(requestId, { children: childStates, stage: `download:${typekey}`, progress: 5 + Math.floor((index / input.typekeys.length) * 40) });
      await recordPetition({ ...input, typekeys: [typekey] }, `${requestId}:${typekey}`, "IN_PROGRESS");
      const outcome = await fetchTypekey(client, input, typekey, requestId, extractionDate);
      specialDetails.push(...outcome.specialDetails);
      childStates[typekey]!.status = "COMPLETED";
      await recordPetition({ ...input, typekeys: [typekey] }, `${requestId}:${typekey}`, "COMPLETED", outcome.relativeRoot);
      activeTypekey = undefined;
    }
    const first = await (async () => {
      const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, `${extractionDate.getFullYear()}${String(extractionDate.getMonth()+1).padStart(2,"0")}${String(extractionDate.getDate()).padStart(2,"0")}`);
      await putJson(`${root}/structured/${requestId}.json`, { input, children: childStates });
      return root;
    })();
    await updateState(requestId, { status: "loading", stage: "load-legacy-tables", progress: 55, s3Path: first });
    await loadTypekeys(input, extractionDate);
    await writeSpecialDetails(specialDetails);
    const catalogs = new Map<string, ReturnType<typeof flattenCatalog>>();
    const rates = new Map<string, ReturnType<typeof flattenFlatrates>>();
    for (const typekey of input.typekeys) {
      const raw = await readRawTypekey(input, typekey, extractionDate);
      catalogs.set(typekey, flattenCatalog(typekey, raw.catalog));
      rates.set(typekey, [...raw.groups.values()].flatMap(groups => flattenFlatrates(typekey, groups)));
    }
    await updateState(requestId, { status: "pivoting", stage: "build-pivot", progress: 70 });
    const pivot = buildPivot(catalogs, rates);
    await savePivotSafe(input, pivot);
    const reportKey = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, "reports", `bmw_${requestId}_DDA.xlsx`);
    let reportReady = false;
    try {
      await updateState(requestId, { status: "reporting", stage: "dda-excel", progress: 90 });
      const dda = await readDdaRows();
      const pivotRows = await readPivotRows(`${input.axCode}_${input.edition}`, input.typekeys);
      const workbook = await buildDdaWorkbook(dda, input.typekeys, databasePivotIndex(pivotRows, input.typekeys));
      await putBytes(reportKey, workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reportReady = true;
    } catch (error) {
      console.error(JSON.stringify({ event: "dda_report_unavailable", requestId, error: error instanceof Error ? error.message : String(error) }));
    }
    await updateState(requestId, { status: "completed", stage: "completed", progress: 100, s3Path: first, ...(reportReady ? { reportKey } : {}) });
    return { requestId, reportKey, pivotRows: pivot.length };
  } catch (error) {
    if (input && activeTypekey) await recordPetition({ ...input, typekeys: [activeTypekey] }, `${requestId}:${activeTypekey}`, "FAILED").catch(() => undefined);
    await updateState(requestId, { status: "failed", stage: "failed", progress: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await releaseDedup(requestInput, requestId).catch(() => undefined);
  }
}

export function createExtractionWorker() { return new Worker("bmw-extractions", processExtraction, { ...connection, concurrency: config.JOB_CONCURRENCY }); }
export async function getDownloadUrl(requestId: string) {
  const value = await state(requestId);
  if (!value?.reportKey) throw new Error("Report is not ready");
  return signedDownload(value.reportKey);
}
