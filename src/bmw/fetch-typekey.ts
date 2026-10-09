import type { BmwClient } from "./client.js";
import { catalogItems, flatrateGroups, findAwSheetGroups } from "./parse.js";
import { deletePrefix, getJsonIfExists, objectKey, putJson, putJsonCompact } from "../storage.js";
import { config } from "../config.js";
import { normalizeModelSeries, relativeTypekeyPath } from "../model-series.js";
import { addCompletedRequest, typekeyProgressStore, type TypekeyCompletedMarker, type TypekeyProgressStore } from "../typekey-progress.js";
import type { ExtractionInput } from "../types.js";
import { mapConcurrent } from "reader-core/util/concurrency";
import { createKeyspace } from "reader-core/redis/keyspace";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const bmwKey = createKeyspace("bmw-reader");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export async function finalizeTypekeyProgress(
  completionKey: string,
  completion: TypekeyCompletedMarker,
  progressStore: TypekeyProgressStore = typekeyProgressStore,
) {
  await putJsonCompact(completionKey, completion);
  await progressStore.clear(completion.path);
}
export function isUpstreamOutage(outcomes: boolean[], threshold = 3) {
  return outcomes.slice(-threshold).length === threshold && outcomes.slice(-threshold).every(success => !success);
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
  progressStore: TypekeyProgressStore = typekeyProgressStore,
  forceRestart = false,
) {
  const series = normalizeModelSeries(input.series ?? "");
  const relativeRoot = relativeTypekeyPath("BMW", input.manufacturer, series, input.family, dateStamp(date), typekey);
  const root = objectKey("BMW", input.manufacturer, "labour", series, input.family, dateStamp(date), typekey);
  const completionKey = `${root}/${typekey}_completed.json`;
  let completedMarker = await getJsonIfExists<TypekeyCompletedMarker>(completionKey);
  if (completedMarker) {
    completedMarker = {
      schemaVersion: completedMarker.schemaVersion ?? 1,
      path: completedMarker.path ?? relativeRoot,
      group: completedMarker.group ?? "BMW",
      manufacturer: completedMarker.manufacturer ?? input.manufacturer,
      series: completedMarker.series ?? series,
      model: completedMarker.model ?? input.model ?? "",
      family: completedMarker.family ?? input.family,
      typekey: completedMarker.typekey ?? typekey,
      date: completedMarker.date ?? dateStamp(date),
      hgs: completedMarker.hgs,
      awSheetOIDs: completedMarker.awSheetOIDs,
      inklusivPositionenFiles: completedMarker.inklusivPositionenFiles ?? 0,
      umfasstTexteFiles: completedMarker.umfasstTexteFiles ?? 0,
      startedAt: completedMarker.startedAt ?? completedMarker.completedAt,
      completedAt: completedMarker.completedAt ?? new Date().toISOString(),
      durationMs: completedMarker.durationMs ?? 0,
      language: completedMarker.language ?? input.language ?? config.BMW_API_LANGUAGE,
      requestId: completedMarker.requestId ?? requestId,
      axCode: completedMarker.axCode ?? input.axCode ?? null,
      edition: completedMarker.edition ?? input.edition ?? null,
      requests: completedMarker.requests ?? [],
    };
    const updated = addCompletedRequest({ ...completedMarker, requests: completedMarker.requests ?? [] }, { requestId, axCode: input.axCode ?? null, edition: input.edition ?? null, at: new Date().toISOString(), reused: true });
    if (updated !== completedMarker) await putJsonCompact(completionKey, updated);
    await progressStore.clear(relativeRoot);
    return { typekey, root, relativeRoot, hgs: updated.hgs, awSheetOIDs: updated.awSheetOIDs, completedAwSheetOIDs: updated.awSheetOIDs, remainingAwSheetOIDs: 0, failedOids: {}, requestId };
  }
  let fatalError = await progressStore.fatalError(relativeRoot);
  if (fatalError && !forceRestart) {
    const error = new Error(`${fatalError}. Submit a new POST /labours request to retry this typekey.`);
    error.name = "TypekeyCancelled";
    throw error;
  }
  if (fatalError && forceRestart) {
    await deletePrefix(root);
    await progressStore.clear(relativeRoot);
  }
  await progressStore.initialize(relativeRoot, { requestId, axCode: input.axCode, edition: input.edition, language: input.language ?? config.BMW_API_LANGUAGE, forceRestart });
  const canResume = resume && (await progressStore.completed(relativeRoot)).length > 0;
  let rawCatalog: unknown;
  let catalogNeedsWrite = false;
  if (canResume) {
    rawCatalog = await getJsonIfExists<unknown>(`${root}/${typekey}_catalog.json`);
    if (rawCatalog === undefined) { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  } else { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  const catalog = catalogItems(rawCatalog);
  if (catalogNeedsWrite) await putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))];
  await onProgress?.({ stage: "catalog", completed: 1, total: 1, detail: `${hgs.length} HG groups found`, hgs: hgs.length });
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  const rawGroupsByHg = new Map<string, unknown>();
  if (canResume) {
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
    let completed = 0;
    await mapConcurrent(missingHgs, Math.min(3, config.BMW_RATE_LIMIT_PER_SEC), async hg => {
      const raw = await client.flatRates(typekey, hg);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      rawGroupsByHg.set(hg, raw);
      groupsByHg.set(hg, flatrateGroups(raw));
      completed++;
      await onProgress?.({ stage: "flat-rates", completed, total: missingHgs.length, detail: hg });
    });
  } else {
    let completed = 0;
    await mapConcurrent(hgs, Math.min(3, config.BMW_RATE_LIMIT_PER_SEC), async hg => {
      const raw = await client.flatRates(typekey, hg);
      const groups = flatrateGroups(raw);
      rawGroupsByHg.set(hg, raw);
      groupsByHg.set(hg, groups);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      completed++;
      await onProgress?.({ stage: "flat-rates", completed, total: hgs.length, detail: hg });
    });
  }
  const awSheets = findAwSheetGroups(groupsByHg);
  const generatedManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  const storedManifest = await getJsonIfExists<Record<string, { groups: string[] }>>(`${root}/${typekey}_awSheetOIDsAndGroups.json`);
  if (!storedManifest) await putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, generatedManifest);
  let completedAwSheets = 0;
  const completedOids = new Set<string>(canResume ? await progressStore.completed(relativeRoot) : []);
  const failedOids = new Map<string, string>(Object.entries(await progressStore.failures(relativeRoot)));
  let outageDetected = false;
  for (const oid of [...completedOids]) if (!awSheets.has(oid)) completedOids.delete(oid);
  const pendingAwSheets = [...awSheets.entries()].filter(([oid]) => !completedOids.has(oid));
  completedAwSheets = completedOids.size;
  let processedThisBatch = 0;
  await onProgress?.({ stage: "aw-sheet-details", completed: completedAwSheets, total: awSheets.size, failed: failedOids.size, hgs: hgs.length });
  const runOid = async ([oid, groups]: [string, Set<string>], retry = false) => {
    if (shouldStop()) return;
    try {
      const details = await fetchAwSheetDetails(client, typekey, oid, groups, root);
      const inclusiveFiles = details.inclusiveCount ? groups.size : 0;
      const umfasstFiles = details.umfasstCount ? groups.size : 0;
      await progressStore.recordCompleted(relativeRoot, oid, inclusiveFiles, umfasstFiles);
      completedOids.add(oid);
      failedOids.delete(oid);
      completedAwSheets = completedOids.size;
      if (!retry) settledResults.push(true);
    } catch (error) {
      if (!(error instanceof Error && "retryWindowExhausted" in error && error.retryWindowExhausted === true)) throw error;
      failedOids.set(oid, error.message);
      await progressStore.recordFailed(relativeRoot, oid, error.message);
      settledResults.push(false);
      if (settledResults.length > 3) settledResults.shift();
      const recent = settledResults.slice(-3);
      outageDetected = isUpstreamOutage(recent);
      console.error(JSON.stringify({ event: "typekey_oid_deferred", requestId, typekey, oid, consecutiveFailures: recent.filter(success => !success).length, error: error.message }));
    } finally {
      processedThisBatch++;
      if (processedThisBatch >= 25 || shouldStop() || outageDetected) {
        processedThisBatch = 0;
        await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs: hgs.length });
      }
    }
  };
  const settledResults: boolean[] = [];
  await mapConcurrent(pendingAwSheets, config.BMW_AW_SHEET_CONCURRENCY, item => runOid(item), () => !shouldStop() && !outageDetected);
  if (processedThisBatch > 0) {
    processedThisBatch = 0;
    await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs: hgs.length });
  }
  if (failedOids.size && !outageDetected && !shouldStop()) {
    const retryRows = [...failedOids.keys()].flatMap(oid => awSheets.has(oid) ? [[oid, awSheets.get(oid)!] as [string, Set<string>]] : []);
    await mapConcurrent(retryRows, config.BMW_AW_SHEET_CONCURRENCY, async item => {
      const oid = item[0];
      failedOids.delete(oid);
      try { await runOid(item, true); }
      catch (error) { failedOids.set(oid, error instanceof Error ? error.message : String(error)); }
    }, () => !shouldStop() && !outageDetected);
  }
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
    const error = new Error(`Typekey ${typekey} still has failed OIDs: ${[...failedOids.entries()].map(([oid, message]) => `${oid} (${message})`).join("; ")}`);
    error.name = "TypekeyOidFailures";
    throw error;
  }
  const completedCount = completedOids.size;
  if (completedCount === awSheets.size) {
    const completedAt = new Date().toISOString();
    const currentMeta = await progressStore.metadata(relativeRoot);
    const completionBase: TypekeyCompletedMarker = {
      schemaVersion: 1, path: relativeRoot, group: "BMW", manufacturer: input.manufacturer,
      series,
      model: input.model ?? "", family: input.family, typekey, date: dateStamp(date), hgs: hgs.length,
      awSheetOIDs: awSheets.size, inklusivPositionenFiles: currentMeta.inklusivPositionenFiles,
      umfasstTexteFiles: currentMeta.umfasstTexteFiles, startedAt: currentMeta.startedAt, completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(currentMeta.startedAt)),
      language: currentMeta.language, requestId: currentMeta.requestId, axCode: currentMeta.axCode,
      edition: currentMeta.edition, requests: [],
    };
    const completion = addCompletedRequest(completionBase, { requestId, axCode: input.axCode ?? null, edition: input.edition ?? null, at: completedAt, reused: false });
    await finalizeTypekeyProgress(completionKey, completion, progressStore);
  }
  return { typekey, root, relativeRoot, hgs: hgs.length, awSheetOIDs: awSheets.size, completedAwSheetOIDs: completedCount, remainingAwSheetOIDs: awSheets.size - completedCount, failedOids: {}, requestId };
}

export function typekeyArtifacts(input: ExtractionInput, summaries: NonNullable<import("../types.js").JobState["extractionSummary"]>["typekeys"], bucket: string) {
  return summaries.flatMap(summary => {
    const key = relativeTypekeyPath("BMW", input.manufacturer, summary.series ?? input.series ?? "", summary.family, input.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, ""), summary.typekey);
    return [
      { name: summary.typekey, kind: "prefix" as const, primary: false, location: { bucket, key: objectKey(...key.split("/")) } },
      { name: `${summary.typekey}_completed.json`, kind: "file" as const, contentType: "application/json", primary: false, location: { bucket, key: objectKey(...key.split("/"), `${summary.typekey}_completed.json`) } },
    ];
  });
}
