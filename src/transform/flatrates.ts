import type { CatalogEntry, FlatrateGroup, JsonRecord } from "../types.js";
import type { CatalogRow } from "./catalog.js";

export type FlatrateRow = {
  typekeyIdEntriesId: string;
  catalogPaths: string[];
  containsValidityExpression: boolean | null;
  klammerText: string;
  lackFlaeche: number | null;
  lackStufe: number | null;
  orderNumber: string;
  rubrikText: string;
  solrId: string;
  sonderAw: boolean | null;
  text: string;
  valid: boolean | null;
  flatrate: Record<string, string | number | boolean | null>;
};

const str = (x: unknown) => x == null ? "" : String(x);
const nullable = <T extends string | number | boolean>(x: unknown): T | null => x == null ? null : x as T;

export function flattenFlatrates(typekey: string, groups: FlatrateGroup[]): FlatrateRow[] {
  return groups.flatMap(group => (group.flatrates ?? []).map(flatrate => ({
    typekeyIdEntriesId: typekey,
    catalogPaths: [...new Set(group.catalogPaths ?? [])],
    containsValidityExpression: nullable<boolean>(group.containsValidityExpression),
    klammerText: str(group.klammerText),
    lackFlaeche: nullable<number>(group.lackFlaeche),
    lackStufe: nullable<number>(group.lackStufe),
    orderNumber: str(group.orderNumber),
    rubrikText: str(group.rubrikText),
    solrId: str(group.solrId),
    sonderAw: nullable<boolean>(group.sonderAw),
    text: str(group.text),
    valid: nullable<boolean>(group.valid),
    flatrate: {
      awSheetOID: nullable<string>(flatrate.awSheetOID), displayType: nullable<string>(flatrate.displayType),
      hasInklusivPositionen: nullable<boolean>(flatrate.hasInklusivPositionen), hasUmfasstTexte: nullable<boolean>(flatrate.hasUmfasstTexte),
      klammerText: nullable<string>(flatrate.klammerText), lackFlaeche: nullable<number>(flatrate.lackFlaeche),
      lackStufe: nullable<number>(flatrate.lackStufe), lackwertMetallic: nullable<number>(flatrate.lackwertMetallic),
      lackwertUni: nullable<number>(flatrate.lackwertUni), number: nullable<string>(flatrate.number),
      ruestwert: nullable<number>(flatrate.ruestwert), sonderAw: nullable<boolean>(flatrate.sonderAw),
      tcRelevant: nullable<boolean>(flatrate.tcRelevant), text: nullable<string>(flatrate.text),
      validFrom: nullable<string>(flatrate.validFrom), validityExpression: nullable<string>(flatrate.validityExpression),
      value: nullable<number>(flatrate.value), workType: nullable<string>(flatrate.workType),
    },
  })));
}

export function flatrateGroups(value: unknown): FlatrateGroup[] {
  if (!value || typeof value !== "object") return [];
  const groups = (value as { flatrateGroups?: unknown }).flatrateGroups;
  return Array.isArray(groups) ? groups.filter((g): g is FlatrateGroup => !!g && typeof g === "object") : [];
}

const flatNumber = (v: unknown) => String(v ?? "");
function entryPartId(id: string) { const ix = id.indexOf("_"); return ix < 0 ? id : id.slice(ix); }
function pathsMatch(entry: CatalogRow, paths: string[]) {
  const suffix = entryPartId(entry.entriesId);
  return paths.some(path => path.split(/\s+/).some(segment => {
    const entryStart = segment.indexOf(suffix);
    return entryStart >= 0 && !/[A-Za-z0-9]/.test(segment[entryStart + suffix.length] ?? "");
  }));
}
function rowIdentity(row: Omit<import("../types.js").PivotRow, "values">) {
  return [row.typekeyCatalog_id, row.typekeyCatalog_number, row.typekeyCatalog_text, row.typekeyCatalog_entriesId, row.typekeyCatalog_entriesNumber, row.typekeyCatalog_entriesText,
    row.typekeyIdEntriesId_catalogPaths, row.typekeyIdEntriesId_rubrikText, row.typekeyIdEntriesId_text,
    row.typekeyIdEntriesId_flatrates_awSheetOID, row.typekeyIdEntriesId_flatrates_number, row.typekeyIdEntriesId_flatrates_text,
    row.typekeyIdEntriesId_flatrates_workType, row.typekeyIdEntriesId_flatrates_klammerText, row.orderNumber].join("\u001f");
}

export function buildPivot(catalogByType: Map<string, CatalogRow[]>, ratesByType: Map<string, FlatrateRow[]>) {
  const pivots = new Map<string, import("../types.js").PivotRow>();
  for (const [typekey, entries] of catalogByType) {
    const rates = ratesByType.get(typekey) ?? [];
    for (const entry of entries) {
      for (const rate of rates.filter(item => pathsMatch(entry, item.catalogPaths))) {
        const f = rate.flatrate;
        const workType = flatNumber(f.workType);
        const sa = String(f.validityExpression ?? "").match(/SONDERAUSSTATTUNG\s*\(?\s*['"]?([A-Z0-9]{4})/i)?.[1];
        const base = {
          typekeyCatalog_id: entry.id, typekeyCatalog_number: entry.number, typekeyCatalog_text: entry.text,
          typekeyCatalog_entriesId: entry.entriesId, typekeyCatalog_entriesNumber: entry.entriesNumber, typekeyCatalog_entriesText: entry.entriesText,
          typekeyIdEntriesId_catalogPaths: rate.catalogPaths.join(" | "), typekeyIdEntriesId_rubrikText: rate.rubrikText,
          typekeyIdEntriesId_text: rate.text, typekeyIdEntriesId_flatrates_awSheetOID: flatNumber(f.awSheetOID),
          typekeyIdEntriesId_flatrates_number: flatNumber(f.number), typekeyIdEntriesId_flatrates_text: flatNumber(f.text),
          typekeyIdEntriesId_flatrates_workType: sa && !workType.includes(sa) ? `${workType} ${sa}`.trim() : workType,
          typekeyIdEntriesId_flatrates_klammerText: flatNumber(f.klammerText), orderNumber: rate.orderNumber,
        };
        const key = rowIdentity(base);
        const row = pivots.get(key) ?? { ...base, values: {} };
        row.values[typekey] = f.value == null ? "" : String(f.value);
        pivots.set(key, row);
      }
    }
  }
  return [...pivots.values()];
}

export function findAwSheetGroups(groupsByHg: Map<string, FlatrateGroup[]>) {
  const result = new Map<string, Set<string>>();
  for (const [hg, groups] of groupsByHg) for (const group of groups) for (const rate of group.flatrates ?? []) {
    if (!rate.awSheetOID) continue;
    const hgs = result.get(rate.awSheetOID) ?? new Set<string>(); hgs.add(hg); result.set(rate.awSheetOID, hgs);
  }
  return result;
}

export function awSheetId(value: JsonRecord) { return String(value.awSheetOID ?? ""); }
