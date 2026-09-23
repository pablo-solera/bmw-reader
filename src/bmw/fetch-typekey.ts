import { BmwClient } from "./client.js";
import { catalogItems } from "../transform/catalog.js";
import { flatrateGroups, findAwSheetGroups } from "../transform/flatrates.js";
import { getJson, objectKey, putJson } from "../storage.js";
import type { ExtractionInput } from "../types.js";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
async function mapConcurrent<T>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
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
  onProgress?: (event: { stage: string; completed: number; total: number; detail?: string }) => void,
  resume = false,
) {
  const relativeRoot = [input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey].join("/");
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey);
  const progressRoot = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), "_progress", typekey);
  let rawCatalog: unknown;
  if (resume) {
    try { rawCatalog = await getJson<unknown>(`${root}/${typekey}_catalog.json`); }
    catch { rawCatalog = await client.catalog(typekey); }
  } else rawCatalog = await client.catalog(typekey);
  const catalog = catalogItems(rawCatalog);
  await putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))];
  onProgress?.({ stage: "catalog", completed: 1, total: 1, detail: `${hgs.length} HG groups found` });
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  for (const [index, hg] of hgs.entries()) {
    const groupKey = `${root}/${hg}/${typekey}_${hg}.json`;
    let rawRates: unknown;
    let fetched = false;
    if (resume) {
      try { rawRates = await getJson<unknown>(groupKey); }
      catch { rawRates = await client.flatRates(typekey, hg); fetched = true; }
    } else { rawRates = await client.flatRates(typekey, hg); fetched = true; }
    const groups = flatrateGroups(rawRates);
    groupsByHg.set(hg, groups);
    if (fetched) await putJson(groupKey, rawRates);
    onProgress?.({ stage: "flat-rates", completed: index + 1, total: hgs.length, detail: hg });
  }
  const awSheets = findAwSheetGroups(groupsByHg);
  const specialDetails: Array<{ awSheetOID: string; kind: "umfassttexte" | "inklusivpositionen"; type: string; payload: unknown }> = [];
  const awSheetManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  await putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, awSheetManifest);
  let completedAwSheets = 0;
  await mapConcurrent([...awSheets.entries()], 6, async ([oid, groups]) => {
    const completionKey = `${progressRoot}/${oid}.json`;
    if (resume) {
      let wasCompleted = false;
      try { await getJson(completionKey); wasCompleted = true; } catch { /* not completed: fetch details below */ }
      if (wasCompleted) {
        completedAwSheets++;
        if (completedAwSheets === 1 || completedAwSheets % 50 === 0 || completedAwSheets === awSheets.size) onProgress?.({ stage: "aw-sheet-details", completed: completedAwSheets, total: awSheets.size });
        return;
      }
    }
    const details = await fetchAwSheetDetails(client, typekey, oid, groups, root);
    for (const hg of groups) {
      if (details.inclusiveCount) specialDetails.push({ awSheetOID: oid, kind: "inklusivpositionen", type: `${typekey}_${hg}`, payload: details.inclusive });
      if (details.umfasstCount) specialDetails.push({ awSheetOID: oid, kind: "umfassttexte", type: `${typekey}_${hg}`, payload: details.surrounding });
    }
    await putJson(completionKey, { awSheetOID: oid, ...{ inclusiveCount: details.inclusiveCount, umfasstCount: details.umfasstCount }, completedAt: new Date().toISOString() });
    completedAwSheets++;
    if (completedAwSheets === 1 || completedAwSheets % 50 === 0 || completedAwSheets === awSheets.size) {
      onProgress?.({ stage: "aw-sheet-details", completed: completedAwSheets, total: awSheets.size });
    }
  });
  return { typekey, root, relativeRoot, hgs: hgs.length, awSheetOIDs: awSheets.size, requestId, specialDetails };
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
