import { BmwClient } from "./client.js";
import { catalogItems } from "../transform/catalog.js";
import { flatrateGroups, findAwSheetGroups } from "../transform/flatrates.js";
import { deletePrefix, getJson, getJsonIfExists, listObjectKeys, objectKey, putJson, putJsonCompact } from "../storage.js";
import { config } from "../config.js";
import { recordCompletedOid } from "../rate-metrics.js";
import type { ExtractionInput } from "../types.js";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export async function finalizeTypekeyProgress(
  completionKey: string,
  progressRoot: string,
  completion: { typekey: string; date: string; hgs: number; awSheetOIDs: number; completedAt: string; requestId: string },
  writeJson: typeof putJsonCompact = putJsonCompact,
  removePrefix: typeof deletePrefix = deletePrefix,
) {
  await writeJson(completionKey, completion);
  await removeTypekeyProgress(progressRoot, completion.typekey, removePrefix);
}

export async function removeTypekeyProgress(progressRoot: string, typekey: string, removePrefix: typeof deletePrefix = deletePrefix) {
  try { await removePrefix(progressRoot); }
  catch (error) { console.warn(JSON.stringify({ event: "typekey_progress_cleanup_failed", typekey, error: error instanceof Error ? error.message : String(error) })); }
}
export async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>, shouldContinue: () => boolean = () => true): Promise<R[]> {
  let next = 0;
  let firstError: unknown;
  let failed = false;
  const results = new Array<R>(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (failed || !shouldContinue()) return;
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await run(items[index]!, index); }
      catch (error) { failed = true; firstError ??= error; return; }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

export function isUpstreamOutage(outcomes: boolean[], threshold = 3) {
  return outcomes.slice(-threshold).length === threshold && outcomes.slice(-threshold).every(success => !success);
}

export async function withFinalCheckpoint<T>(run: () => Promise<T>, saveCheckpoint: () => Promise<void>): Promise<T> {
  try { return await run(); }
  finally { await saveCheckpoint(); }
}

type AwSheetClient = Pick<BmwClient, "inklusivPositionen" | "umfasstTexte">;

export async function fetchAwSheetDetails(
  client: AwSheetClient,
  typekey: string,
  oid: string,
  groups: Set<string>,
  root: string,
  writeJson: typeof putJson = putJson,
) {
  const [inclusive, surrounding] = await Promise.all([
    client.inklusivPositionen(typekey, oid),
    client.umfasstTexte(typekey, oid),
  ]);
  const writes = [...[...groups].flatMap(hg => [
    ...(arrayValue(inclusive).length ? [{ key: `${root}/${hg}/${oid}_inklusivpositionen.json`, payload: inclusive }] : []),
    ...(arrayValue(surrounding).length ? [{ key: `${root}/${hg}/${oid}_umfassttexte.json`, payload: surrounding }] : []),
  ])];
  await mapConcurrent(writes, Math.max(1, config.BMW_AW_SHEET_CONCURRENCY * 2), write => writeJson(write.key, write.payload));
  return { inclusiveCount: arrayValue(inclusive).length, umfasstCount: arrayValue(surrounding).length, inclusive, surrounding };
}

export async function fetchTypekey(
  client: BmwClient,
  input: ExtractionInput,
  typekey: string,
  requestId: string,
  date = new Date(),
  onProgress?: (event: { stage: string; completed: number; total: number; detail?: string; failed?: number; hgs?: number }) => void | Promise<void>,
  resume = false,
  shouldStop: () => boolean = () => false,
) {
  const relativeRoot = [input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey].join("/");
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey);
  const progressRoot = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), "_progress", typekey);
  const checkpointKey = `${progressRoot}/_state.json`;
  const completionKey = `${root}/${typekey}_completed.json`;
  const completedMarker = await getJsonIfExists<{ hgs: number; awSheetOIDs: number; completedAt: string }>(completionKey);
  if (completedMarker) {
    await removeTypekeyProgress(progressRoot, typekey);
    return { typekey, root, relativeRoot, hgs: completedMarker.hgs, awSheetOIDs: completedMarker.awSheetOIDs, completedAwSheetOIDs: completedMarker.awSheetOIDs, remainingAwSheetOIDs: 0, failedOids: {}, requestId };
  }
  let rawCatalog: unknown;
  let catalogNeedsWrite = false;
  if (resume) {
    rawCatalog = await getJsonIfExists<unknown>(`${root}/${typekey}_catalog.json`);
    if (rawCatalog === undefined) { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  } else { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  const catalog = catalogItems(rawCatalog);
  if (catalogNeedsWrite) await putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))];
  await onProgress?.({ stage: "catalog", completed: 1, total: 1, detail: `${hgs.length} HG groups found`, hgs: hgs.length });
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  const rawGroupsByHg = new Map<string, unknown>();
  if (resume) {
    let loaded = 0;
    const loadedRows = await mapConcurrent(hgs, 8, async hg => {
      const groupKey = `${root}/${hg}/${typekey}_${hg}.json`;
      const raw = await getJsonIfExists<unknown>(groupKey);
      if (raw !== undefined) loaded++;
      return { hg, raw };
    });
    for (const { hg, raw } of loadedRows) {
      if (raw !== undefined) {
        rawGroupsByHg.set(hg, raw);
        groupsByHg.set(hg, flatrateGroups(raw));
      }
    }
    await onProgress?.({ stage: "flat-rates-cache", completed: loaded, total: hgs.length });
    const missingHgs = loadedRows.filter(row => row.raw === undefined).map(row => row.hg);
    for (const [index, hg] of missingHgs.entries()) {
      const raw = await client.flatRates(typekey, hg);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      rawGroupsByHg.set(hg, raw);
      groupsByHg.set(hg, flatrateGroups(raw));
      await onProgress?.({ stage: "flat-rates", completed: index + 1, total: missingHgs.length, detail: hg });
    }
  } else {
    for (const [index, hg] of hgs.entries()) {
      const raw = await client.flatRates(typekey, hg);
      const groups = flatrateGroups(raw);
      rawGroupsByHg.set(hg, raw);
      groupsByHg.set(hg, groups);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      await onProgress?.({ stage: "flat-rates", completed: index + 1, total: hgs.length, detail: hg });
    }
  }
  const awSheets = findAwSheetGroups(groupsByHg);
  const generatedManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  const storedManifest = await getJsonIfExists<Record<string, { groups: string[] }>>(`${root}/${typekey}_awSheetOIDsAndGroups.json`);
  const awSheetManifest = storedManifest ?? generatedManifest;
  if (!storedManifest) await putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, generatedManifest);
  let completedAwSheets = 0;
  const completedOids = new Set<string>();
  const failedOids = new Map<string, string>();
  let outageDetected = false;
  if (resume) {
    const checkpoint = await getJsonIfExists<{ completedOids?: unknown; failedOids?: Record<string, string>; consecutiveFailures?: number }>(checkpointKey);
    if (checkpoint && Array.isArray(checkpoint.completedOids) && !checkpoint.completedOids.some(oid => typeof oid !== "string")) {
      for (const oid of checkpoint.completedOids) completedOids.add(oid as string);
      for (const [oid, reason] of Object.entries(checkpoint.failedOids ?? {})) if (!completedOids.has(oid)) failedOids.set(oid, reason);
      outageDetected = false;
    } else {
      const completedMarkerKeys = new Set<string>();
      await listObjectKeys(`${progressRoot}/`, 1000, undefined, keys => {
        for (const key of keys) if (!key.endsWith("/_state.json")) completedMarkerKeys.add(key);
      });
      for (const oid of awSheets.keys()) if (completedMarkerKeys.has(`${progressRoot}/${oid}.json`)) completedOids.add(oid);
      await putJsonCompact(checkpointKey, { typekey, total: awSheets.size, completedOids: [...completedOids], updatedAt: new Date().toISOString() });
    }
  }
  for (const oid of [...completedOids]) if (!awSheets.has(oid)) completedOids.delete(oid);
  const pendingAwSheets = [...awSheets.entries()].filter(([oid]) => !completedOids.has(oid));
  completedAwSheets = completedOids.size;
  let checkpointWrites = Promise.resolve();
  let processedThisBatch = 0;
  const saveCheckpoint = () => {
    const completedSnapshot = [...completedOids];
    const failedSnapshot = Object.fromEntries(failedOids);
    checkpointWrites = checkpointWrites.then(() => putJsonCompact(checkpointKey, { typekey, total: awSheets.size, completedOids: completedSnapshot, failedOids: failedSnapshot, updatedAt: new Date().toISOString() }));
    processedThisBatch = 0;
    return checkpointWrites;
  };
  await onProgress?.({ stage: "aw-sheet-details", completed: completedAwSheets, total: awSheets.size, failed: failedOids.size, hgs: hgs.length });
  let consecutiveExhausted = 0;
  const runOid = async ([oid, groups]: [string, Set<string>], retry = false) => {
    if (shouldStop()) return;
    try {
      await fetchAwSheetDetails(client, typekey, oid, groups, root);
      completedOids.add(oid);
      failedOids.delete(oid);
      completedAwSheets = completedOids.size;
      recordCompletedOid(requestId);
      if (!retry) settledResults.push(true);
    } catch (error) {
      if (!(error instanceof Error && "retryWindowExhausted" in error && error.retryWindowExhausted === true)) throw error;
      failedOids.set(oid, error.message);
      if (retry) throw error;
      settledResults.push(false);
      if (settledResults.length > 3) settledResults.shift();
      const recent = settledResults.slice(-3);
      outageDetected = isUpstreamOutage(recent);
      console.error(JSON.stringify({ event: "typekey_oid_deferred", requestId, typekey, oid, consecutiveFailures: recent.filter(success => !success).length, error: error.message }));
      if (retry) throw error;
    } finally {
      processedThisBatch++;
      if (processedThisBatch >= 25 || shouldStop() || outageDetected) {
        await saveCheckpoint();
        await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs: hgs.length });
      }
    }
  };
  const settledResults: boolean[] = [];
  await withFinalCheckpoint(async () => {
    await mapConcurrent(pendingAwSheets, config.BMW_AW_SHEET_CONCURRENCY, item => runOid(item), () => !shouldStop() && !outageDetected);
    if (failedOids.size && !outageDetected && !shouldStop()) {
      const retryRows = [...failedOids.keys()].flatMap(oid => awSheets.has(oid) ? [[oid, awSheets.get(oid)!] as [string, Set<string>]] : []);
      await mapConcurrent(retryRows, config.BMW_AW_SHEET_CONCURRENCY, async item => {
        const oid = item[0];
        failedOids.delete(oid);
        try { await runOid(item, true); }
        catch (error) { failedOids.set(oid, error instanceof Error ? error.message : String(error)); }
      }, () => !shouldStop() && !outageDetected);
    }
  }, saveCheckpoint);
  if (outageDetected) {
    const error = new Error(`BMW appears unavailable after 3 consecutive OID failures for typekey ${typekey}; checkpoint saved`);
    error.name = "TypekeyOidFailures";
    throw error;
  }
  if (shouldStop()) {
    const completedCount = completedOids.size;
    return { typekey, root, relativeRoot, hgs: hgs.length, awSheetOIDs: awSheets.size, completedAwSheetOIDs: completedCount, remainingAwSheetOIDs: awSheets.size - completedCount, failedOids: Object.fromEntries(failedOids), paused: true, requestId };
  }
  if (failedOids.size) {
    await saveCheckpoint();
    const error = new Error(`Typekey ${typekey} still has failed OIDs: ${[...failedOids.entries()].map(([oid, message]) => `${oid} (${message})`).join("; ")}`);
    error.name = "TypekeyOidFailures";
    throw error;
  }
  const completedCount = completedOids.size;
  if (completedCount === awSheets.size) {
    await finalizeTypekeyProgress(completionKey, progressRoot, { typekey, date: dateStamp(date), hgs: hgs.length, awSheetOIDs: awSheets.size, completedAt: new Date().toISOString(), requestId });
  }
  return { typekey, root, relativeRoot, hgs: hgs.length, awSheetOIDs: awSheets.size, completedAwSheetOIDs: completedCount, remainingAwSheetOIDs: awSheets.size - completedCount, failedOids: {}, requestId };
}

export async function readRawTypekey(input: ExtractionInput, typekey: string, date = new Date()) {
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey);
  const catalog = catalogItems(await getJson<unknown>(`${root}/${typekey}_catalog.json`));
  const groups = new Map<string, ReturnType<typeof flatrateGroups>>();
  for (const hg of [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))]) {
    const result = await getJson<{ flatrateGroups?: unknown }>(`${root}/${hg}/${typekey}_${hg}.json`);
    groups.set(hg, flatrateGroups(result));
  }
  return { root, catalog, groups };
}

export function relativeTypekeyRoot(input: ExtractionInput, typekey: string, date = new Date()) {
  return [input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey].join("/");
}
