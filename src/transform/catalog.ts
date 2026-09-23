import type { CatalogEntry, JsonRecord } from "../types.js";

export type CatalogRow = { typekey: string; id: string; number: string; text: string; entriesId: string; entriesNumber: string; entriesText: string };
export function flattenCatalog(typekey: string, items: CatalogEntry[]): CatalogRow[] {
  return items.flatMap(item => (item.entries ?? []).map(entry => ({ typekey, id: item.id ?? "", number: item.number ?? "", text: item.text ?? "", entriesId: entry.id ?? "", entriesNumber: entry.number ?? "", entriesText: entry.text ?? "" })));
}
export function catalogItems(value: unknown): CatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is CatalogEntry => !!x && typeof x === "object");
}
export function recordArray(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter((x): x is JsonRecord => !!x && typeof x === "object");
  return [];
}
