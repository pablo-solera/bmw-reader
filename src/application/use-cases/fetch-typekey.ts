import type { BmwLabourApi } from "../ports/bmw-labour-api.js";
import type { TypekeyArtifactStore } from "../ports/typekey-artifact-store.js";
import type { TypekeyProgressStore } from "../ports/typekey-progress-store.js";
import { addCompletedRequest, type TypekeyCompletedMarker } from "../../domain/labour/typekey-completion.js";
import { TypekeyCancelledByRequestError, TypekeyOidFailuresError } from "../../domain/labour/errors.js";
import { catalogItems, catalogHgNumbers, flatrateGroups, findAwSheetGroups } from "../bmw/parse.js";
import { normalizeModelSeries } from "../../domain/labour/series.js";
import { relativeTypekeyPath } from "../typekey-path.js";
import type { TypekeyExtractionInput, LabourState } from "../../domain/labour/labour-state.js";
import { mapConcurrent } from "@pablosla/core-reader/shared/concurrency";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function flatRateFetchConcurrency(rateLimitPerSecond: number): number {
  return Math.max(1, rateLimitPerSecond);
}

export type FetchTypekeyServices = TypekeyArtifactStore & {
  progressStore: TypekeyProgressStore;
  settings: { BMW_AW_SHEET_CONCURRENCY: number; BMW_API_LANGUAGE: string; BMW_5XX_RETRY_WINDOW_MS: number; BMW_RATE_LIMIT_PER_SEC: number };
};

export type TypekeyProgressEvent = { stage: string; completed: number; total: number; detail?: string; failed?: number; hgs?: number };
export type FetchTypekeyRequest = {
  client: BmwLabourApi;
  input: TypekeyExtractionInput;
  typekey: string;
  requestId: string;
  date?: Date;
  onProgress?: (event: TypekeyProgressEvent) => void | Promise<void>;
  resume?: boolean;
  shouldStop?: () => boolean;
  forceRestart?: boolean;
};

export function createFetchTypekey(services: FetchTypekeyServices) {
  return (request: FetchTypekeyRequest) => fetchTypekey({ ...request, services });
}
export async function finalizeTypekeyProgress(
  completionKey: string,
  completion: TypekeyCompletedMarker,
  progressStore: TypekeyProgressStore,
  writeJson: (key: string, value: unknown) => Promise<void>,
) {
  await writeJson(completionKey, completion);
  await progressStore.clear(completion.path);
}
export function isUpstreamOutage(outcomes: boolean[], threshold = 3) {
  return outcomes.slice(-threshold).length === threshold && outcomes.slice(-threshold).every(success => !success);
}

type AwSheetClient = Pick<BmwLabourApi, "inklusivPositionen" | "umfasstTexte">;

export async function fetchAwSheetDetails(
  client: AwSheetClient,
  typekey: string,
  oid: string,
  groups: Set<string>,
  root: string,
  writeJson: (key: string, value: unknown) => Promise<void>,
  concurrency: number,
) {
  const [inclusive, surrounding] = await Promise.all([
    client.inklusivPositionen(typekey, oid),
    client.umfasstTexte(typekey, oid),
  ]);
  const writes = [...[...groups].flatMap(hg => [
    ...(arrayValue(inclusive).length ? [{ key: `${root}/${hg}/${oid}_inklusivpositionen.json`, payload: inclusive }] : []),
    ...(arrayValue(surrounding).length ? [{ key: `${root}/${hg}/${oid}_umfassttexte.json`, payload: surrounding }] : []),
  ])];
  await mapConcurrent(writes, Math.max(1, concurrency * 2), write => writeJson(write.key, write.payload));
  return { inclusiveCount: arrayValue(inclusive).length, umfasstCount: arrayValue(surrounding).length, inclusive, surrounding };
}

async function loadFlatRateGroups(
  client: BmwLabourApi,
  typekey: string,
  hgs: string[],
  root: string,
  canResume: boolean,
  services: FetchTypekeyServices,
  onProgress?: (event: TypekeyProgressEvent) => void | Promise<void>,
) {
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  const { settings } = services;
  if (canResume) {
    let loaded = 0;
    const loadedRows = await mapConcurrent(hgs, 8, async hg => {
      const key = `${root}/${hg}/${typekey}_${hg}.json`;
      const raw = await services.getJsonIfExists<unknown>(key);
      if (raw !== undefined) loaded++;
      return { hg, raw };
    });
    for (const { hg, raw } of loadedRows) if (raw !== undefined) groupsByHg.set(hg, flatrateGroups(raw));
    await onProgress?.({ stage: "flat-rates-cache", completed: loaded, total: hgs.length });
    const missingHgs = loadedRows.filter(row => row.raw === undefined).map(row => row.hg);
    let completed = 0;
    await mapConcurrent(missingHgs, flatRateFetchConcurrency(settings.BMW_RATE_LIMIT_PER_SEC), async hg => {
      const raw = await client.flatRates(typekey, hg);
      await services.putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      groupsByHg.set(hg, flatrateGroups(raw));
      completed++;
      await onProgress?.({ stage: "flat-rates", completed, total: missingHgs.length, detail: hg });
    });
    return groupsByHg;
  }

  let completed = 0;
  await mapConcurrent(hgs, flatRateFetchConcurrency(settings.BMW_RATE_LIMIT_PER_SEC), async hg => {
    const raw = await client.flatRates(typekey, hg);
    groupsByHg.set(hg, flatrateGroups(raw));
    await services.putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
    completed++;
    await onProgress?.({ stage: "flat-rates", completed, total: hgs.length, detail: hg });
  });
  return groupsByHg;
}

async function processAwSheets(options: {
  client: BmwLabourApi;
  typekey: string;
  requestId: string;
  root: string;
  relativeRoot: string;
  hgs: number;
  awSheets: Map<string, Set<string>>;
  canResume: boolean;
  services: FetchTypekeyServices;
  onProgress?: (event: TypekeyProgressEvent) => void | Promise<void>;
  shouldStop: () => boolean;
}) {
  const { client, typekey, requestId, root, relativeRoot, hgs, awSheets, canResume, services, onProgress, shouldStop } = options;
  const { progressStore, settings } = services;
  const completedOids = new Set<string>(canResume ? await progressStore.completed(relativeRoot) : []);
  const failedOids = new Map<string, string>(Object.entries(await progressStore.failures(relativeRoot)));
  for (const oid of completedOids) if (!awSheets.has(oid)) completedOids.delete(oid);
  let processedThisBatch = 0;
  let outageDetected = false;
  const settledResults: boolean[] = [];

  await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs });
  const runOid = async ([oid, groups]: [string, Set<string>], retry = false) => {
    if (shouldStop()) return;
    try {
      const details = await fetchAwSheetDetails(client, typekey, oid, groups, root, services.putJson, settings.BMW_AW_SHEET_CONCURRENCY);
      const inclusiveFiles = details.inclusiveCount ? groups.size : 0;
      const umfasstFiles = details.umfasstCount ? groups.size : 0;
      await progressStore.recordCompleted(relativeRoot, oid, inclusiveFiles, umfasstFiles);
      completedOids.add(oid);
      failedOids.delete(oid);
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
        await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs });
      }
    }
  };
  await mapConcurrent([...awSheets.entries()].filter(([oid]) => !completedOids.has(oid)), settings.BMW_AW_SHEET_CONCURRENCY, item => runOid(item), () => !shouldStop() && !outageDetected);
  if (processedThisBatch > 0) {
    processedThisBatch = 0;
    await onProgress?.({ stage: "aw-sheet-details", completed: completedOids.size, total: awSheets.size, failed: failedOids.size, hgs });
  }
  if (failedOids.size && !outageDetected && !shouldStop()) {
    const retryRows = [...failedOids.keys()].flatMap(oid => awSheets.has(oid) ? [[oid, awSheets.get(oid)!] as [string, Set<string>]] : []);
    await mapConcurrent(retryRows, settings.BMW_AW_SHEET_CONCURRENCY, async item => {
      const oid = item[0];
      failedOids.delete(oid);
      try { await runOid(item, true); }
      catch (error) { failedOids.set(oid, error instanceof Error ? error.message : String(error)); }
    }, () => !shouldStop() && !outageDetected);
  }
  if (outageDetected) {
    throw new TypekeyOidFailuresError(`BMW appears unavailable after 3 consecutive OID failures for typekey ${typekey}; checkpoint saved`);
  }
  const completedAwSheetOIDs = completedOids.size;
  const result = {
    typekey,
    root,
    relativeRoot,
    hgs,
    awSheetOIDs: awSheets.size,
    completedAwSheetOIDs,
    remainingAwSheetOIDs: awSheets.size - completedAwSheetOIDs,
    failedOids: Object.fromEntries(failedOids),
    requestId,
    paused: false,
  };
  if (shouldStop()) return { ...result, paused: true };
  if (failedOids.size) {
    throw new TypekeyOidFailuresError(`Typekey ${typekey} still has failed OIDs: ${[...failedOids.entries()].map(([oid, message]) => `${oid} (${message})`).join("; ")}`);
  }
  return result;
}

export async function fetchTypekey({
  client,
  input,
  typekey,
  requestId,
  services,
  date = new Date(),
  onProgress,
  resume = false,
  shouldStop = () => false,
  forceRestart = false,
}: FetchTypekeyRequest & { services: FetchTypekeyServices }) {
  const { progressStore, settings } = services;
  const series = normalizeModelSeries(input.series ?? "");
  const relativeRoot = relativeTypekeyPath("BMW", input.manufacturer, series, input.family, dateStamp(date), typekey);
  const root = services.objectKey(...relativeRoot.split("/"));
  const completionKey = `${root}/${typekey}_completed.json`;
  let completedMarker = await services.getJsonIfExists<TypekeyCompletedMarker>(completionKey);
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
      language: completedMarker.language ?? input.language ?? settings.BMW_API_LANGUAGE,
      requestId: completedMarker.requestId ?? requestId,
      axCode: completedMarker.axCode ?? input.axCode ?? null,
      edition: completedMarker.edition ?? input.edition ?? null,
      requests: completedMarker.requests ?? [],
    };
    const updated = addCompletedRequest({ ...completedMarker, requests: completedMarker.requests ?? [] }, { requestId, axCode: input.axCode ?? null, edition: input.edition ?? null, at: new Date().toISOString(), reused: true });
    if (updated !== completedMarker) await services.putJsonCompact(completionKey, updated);
    await progressStore.clear(relativeRoot);
    return { typekey, root, relativeRoot, hgs: updated.hgs, awSheetOIDs: updated.awSheetOIDs, completedAwSheetOIDs: updated.awSheetOIDs, remainingAwSheetOIDs: 0, failedOids: {}, requestId };
  }
  const cancellationMarker = await progressStore.cancellationMarker(relativeRoot);
  if (cancellationMarker) {
    if (!forceRestart && cancellationMarker.cancelledByRequestId === requestId) {
      throw new TypekeyCancelledByRequestError(`${cancellationMarker.message}. Submit a new POST /labours request to retry this typekey.`);
    }
    await services.deletePrefix(root);
    await progressStore.clear(relativeRoot);
  }
  await progressStore.initialize(relativeRoot, { requestId, axCode: input.axCode, edition: input.edition, language: input.language ?? settings.BMW_API_LANGUAGE, forceRestart });
  const canResume = resume;
  let rawCatalog: unknown;
  let catalogNeedsWrite = false;
  if (canResume) {
    rawCatalog = await services.getJsonIfExists<unknown>(`${root}/${typekey}_catalog.json`);
    if (rawCatalog === undefined) { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  } else { rawCatalog = await client.catalog(typekey); catalogNeedsWrite = true; }
  const catalog = catalogItems(rawCatalog);
  if (catalogNeedsWrite) await services.putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = catalogHgNumbers(catalog);
  await onProgress?.({ stage: "catalog", completed: 1, total: 1, detail: `${hgs.length} HG groups found`, hgs: hgs.length });
  const groupsByHg = await loadFlatRateGroups(client, typekey, hgs, root, canResume, services, onProgress);
  const awSheets = findAwSheetGroups(groupsByHg);
  const generatedManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  const storedManifest = await services.getJsonIfExists<Record<string, { groups: string[] }>>(`${root}/${typekey}_awSheetOIDsAndGroups.json`);
  if (!storedManifest) await services.putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, generatedManifest);
  const outcome = await processAwSheets({ client, typekey, requestId, root, relativeRoot, hgs: hgs.length, awSheets, canResume, services, onProgress, shouldStop });
  if (outcome.paused) return outcome;
  const completedCount = outcome.completedAwSheetOIDs;
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
  await finalizeTypekeyProgress(completionKey, completion, progressStore, services.putJsonCompact);
  }
  return outcome;
}

export function typekeyArtifacts(input: TypekeyExtractionInput, summaries: NonNullable<LabourState["typekeySummary"]>["typekeys"], objectKeyFor: (...parts: string[]) => string, bucket: string) {
  return summaries.flatMap(summary => {
    const key = relativeTypekeyPath("BMW", input.manufacturer, summary.series ?? input.series ?? "", summary.family, input.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, ""), summary.typekey);
    return [
      { name: summary.typekey, kind: "prefix" as const, primary: false, location: { bucket, key: objectKeyFor(...key.split("/")) } },
      { name: `${summary.typekey}_completed.json`, kind: "file" as const, contentType: "application/json", primary: false, location: { bucket, key: objectKeyFor(...key.split("/"), `${summary.typekey}_completed.json`) } },
    ];
  });
}
