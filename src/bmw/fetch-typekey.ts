import { BmwClient } from "./client.js";
import { catalogItems } from "../transform/catalog.js";
import { flatrateGroups, findAwSheetGroups } from "../transform/flatrates.js";
import { getJson, getJsonIfExists, listObjectKeys, objectKey, putJson } from "../storage.js";
import type { ExtractionInput } from "../types.js";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
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
  for (const hg of groups) {
    if (arrayValue(inclusive).length) await writeJson(`${root}/${hg}/${oid}_inklusivpositionen.json`, inclusive);
    if (arrayValue(surrounding).length) await writeJson(`${root}/${hg}/${oid}_umfassttexte.json`, surrounding);
  }
  return { inclusiveCount: arrayValue(inclusive).length, umfasstCount: arrayValue(surrounding).length, inclusive, surrounding };
}

export async function fetchTypekey(
  client: BmwClient,
  input: ExtractionInput,
  typekey: string,
  requestId: string,
  date = new Date(),
  onProgress?: (event: { stage: string; completed: number; total: number; detail?: string }) => void | Promise<void>,
  resume = false,
  maxAwSheetDetails?: number,
  cached?: { catalog: unknown; groupsByHg: Map<string, unknown> },
) {
  const relativeRoot = [input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey].join("/");
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey);
  const progressRoot = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), "_progress", typekey);
  const checkpointKey = `${progressRoot}/_state.json`;
  let rawCatalog: unknown;
  if (cached) rawCatalog = cached.catalog;
  else if (resume) {
    rawCatalog = await getJsonIfExists<unknown>(`${root}/${typekey}_catalog.json`);
    if (rawCatalog === undefined) rawCatalog = await client.catalog(typekey);
  } else rawCatalog = await client.catalog(typekey);
  const catalog = catalogItems(rawCatalog);
  await putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))];
  await onProgress?.({ stage: "catalog", completed: 1, total: 1, detail: `${hgs.length} HG groups found` });
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  if (cached) {
    for (const hg of hgs) {
      const raw = cached.groupsByHg.get(hg);
      if (raw === undefined) throw new Error(`Cached flat-rate response missing for HG ${hg}`);
      groupsByHg.set(hg, flatrateGroups(raw));
    }
    await onProgress?.({ stage: "flat-rates-cache", completed: hgs.length, total: hgs.length });
  } else if (resume) {
    let loaded = 0;
    const loadedRows = await mapConcurrent(hgs, 8, async hg => {
      const groupKey = `${root}/${hg}/${typekey}_${hg}.json`;
      const raw = await getJsonIfExists<unknown>(groupKey);
      if (raw !== undefined) loaded++;
      return { hg, raw };
    });
    for (const { hg, raw } of loadedRows) {
      if (raw !== undefined) groupsByHg.set(hg, flatrateGroups(raw));
    }
    await onProgress?.({ stage: "flat-rates-cache", completed: loaded, total: hgs.length });
    const missingHgs = loadedRows.filter(row => row.raw === undefined).map(row => row.hg);
    for (const [index, hg] of missingHgs.entries()) {
      const raw = await client.flatRates(typekey, hg);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      groupsByHg.set(hg, flatrateGroups(raw));
      await onProgress?.({ stage: "flat-rates", completed: index + 1, total: missingHgs.length, detail: hg });
    }
  } else {
    for (const [index, hg] of hgs.entries()) {
      const raw = await client.flatRates(typekey, hg);
      const groups = flatrateGroups(raw);
      groupsByHg.set(hg, groups);
      await putJson(`${root}/${hg}/${typekey}_${hg}.json`, raw);
      await onProgress?.({ stage: "flat-rates", completed: index + 1, total: hgs.length, detail: hg });
    }
  }
  const awSheets = findAwSheetGroups(groupsByHg);
  const specialDetails: Array<{ awSheetOID: string; kind: "umfassttexte" | "inklusivpositionen"; type: string; payload: unknown }> = [];
  const awSheetManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  await putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, awSheetManifest);
  let completedAwSheets = 0;
  const completedMarkerKeys = new Set<string>();
  if (resume) {
    const checkpoint = await getJsonIfExists<{ completedOids?: unknown }>(checkpointKey);
    if (checkpoint && Array.isArray(checkpoint.completedOids) && !checkpoint.completedOids.some(oid => typeof oid !== "string")) {
      for (const oid of checkpoint.completedOids) completedMarkerKeys.add(`${progressRoot}/${oid}.json`);
    } else {
      await listObjectKeys(`${progressRoot}/`, 1000, undefined, keys => {
        for (const key of keys) if (!key.endsWith("/_state.json")) completedMarkerKeys.add(key);
      });
      const migratedOids = [...awSheets.keys()].filter(oid => completedMarkerKeys.has(`${progressRoot}/${oid}.json`));
      await putJson(checkpointKey, { typekey, total: awSheets.size, completedOids: migratedOids, updatedAt: new Date().toISOString() });
    }
  }
  const completedOids = new Set([...awSheets.keys()].filter(oid => completedMarkerKeys.has(`${progressRoot}/${oid}.json`)));
  const pendingAwSheets = [...awSheets.entries()].filter(([oid]) => !completedOids.has(oid));
  const batchAwSheets = maxAwSheetDetails === undefined ? pendingAwSheets : pendingAwSheets.slice(0, maxAwSheetDetails);
  completedAwSheets = completedOids.size;
  let checkpointWrites = Promise.resolve();
  let processedThisBatch = 0;
  const saveCheckpoint = () => {
    const completedSnapshot = [...completedOids];
    checkpointWrites = checkpointWrites.then(() => putJson(checkpointKey, { typekey, total: awSheets.size, completedOids: completedSnapshot, updatedAt: new Date().toISOString() }));
    processedThisBatch = 0;
    return checkpointWrites;
  };
  await mapConcurrent(batchAwSheets, 6, async ([oid, groups]) => {
    const completionKey = `${progressRoot}/${oid}.json`;
    const details = await fetchAwSheetDetails(client, typekey, oid, groups, root);
    for (const hg of groups) {
      if (details.inclusiveCount) specialDetails.push({ awSheetOID: oid, kind: "inklusivpositionen", type: `${typekey}_${hg}`, payload: details.inclusive });
      if (details.umfasstCount) specialDetails.push({ awSheetOID: oid, kind: "umfassttexte", type: `${typekey}_${hg}`, payload: details.surrounding });
    }
    await putJson(completionKey, { awSheetOID: oid, ...{ inclusiveCount: details.inclusiveCount, umfasstCount: details.umfasstCount }, completedAt: new Date().toISOString() });
    completedOids.add(oid);
    completedAwSheets++;
    if (++processedThisBatch >= 25 || completedAwSheets === awSheets.size) await saveCheckpoint();
    const progressInterval = maxAwSheetDetails !== undefined && maxAwSheetDetails <= 10 ? 1 : 50;
    if (completedAwSheets === 1 || completedAwSheets % progressInterval === 0 || completedAwSheets === awSheets.size) {
      await onProgress?.({ stage: "aw-sheet-details", completed: completedAwSheets, total: awSheets.size });
    }
  });
  if (processedThisBatch > 0) await saveCheckpoint();
  const completedCount = completedOids.size;
  return { typekey, root, relativeRoot, hgs: hgs.length, awSheetOIDs: awSheets.size, completedAwSheetOIDs: completedCount, remainingAwSheetOIDs: awSheets.size - completedCount, requestId, specialDetails };
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
