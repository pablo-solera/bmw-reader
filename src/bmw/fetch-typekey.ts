import { BmwClient } from "./client.js";
import { catalogItems } from "../transform/catalog.js";
import { flatrateGroups, findAwSheetGroups } from "../transform/flatrates.js";
import { getJson, objectKey, putJson } from "../storage.js";
import type { ExtractionInput } from "../types.js";

const dateStamp = (date = new Date()) => date.toISOString().slice(0, 10).replace(/-/g, "");
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export async function fetchTypekey(client: BmwClient, input: ExtractionInput, typekey: string, requestId: string, date = new Date()) {
  const relativeRoot = [input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey].join("/");
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.model, input.family, dateStamp(date), typekey);
  const rawCatalog = await client.catalog(typekey);
  const catalog = catalogItems(rawCatalog);
  await putJson(`${root}/${typekey}_catalog.json`, rawCatalog);
  const hgs = [...new Set(catalog.map(item => String(item.number ?? "")).filter(Boolean))];
  const groupsByHg = new Map<string, ReturnType<typeof flatrateGroups>>();
  for (const hg of hgs) {
    const rawRates = await client.flatRates(typekey, hg);
    const groups = flatrateGroups(rawRates);
    groupsByHg.set(hg, groups);
    await putJson(`${root}/${hg}/${typekey}_${hg}.json`, rawRates);
  }
  const awSheets = findAwSheetGroups(groupsByHg);
  const specialDetails: Array<{ awSheetOID: string; kind: "umfassttexte" | "inklusivpositionen"; type: string; payload: unknown }> = [];
  const awSheetManifest = Object.fromEntries([...awSheets].map(([oid, groups]) => [oid, { groups: [...groups] }]));
  await putJson(`${root}/${typekey}_awSheetOIDsAndGroups.json`, awSheetManifest);
  for (const [oid, groups] of awSheets) {
    const [inclusive, surrounding] = await Promise.all([client.inklusivPositionen(typekey, oid), client.umfasstTexte(typekey, oid)]);
    if (arrayValue(inclusive).length) for (const hg of groups) specialDetails.push({ awSheetOID: oid, kind: "inklusivpositionen", type: `${typekey}_${hg}`, payload: inclusive });
    if (arrayValue(surrounding).length) for (const hg of groups) specialDetails.push({ awSheetOID: oid, kind: "umfassttexte", type: `${typekey}_${hg}`, payload: surrounding });
    for (const hg of groups) {
      if (arrayValue(inclusive).length) await putJson(`${root}/${hg}/${oid}_inklusivpositionen.json`, inclusive);
      if (arrayValue(surrounding).length) await putJson(`${root}/${hg}/${oid}_umfassttexte.json`, surrounding);
    }
  }
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
