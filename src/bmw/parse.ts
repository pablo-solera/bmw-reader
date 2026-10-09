import type { CatalogEntry, FlatrateGroup } from "../types.js";

export function catalogItems(value: unknown): CatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CatalogEntry => !!item && typeof item === "object");
}

export function flatrateGroups(value: unknown): FlatrateGroup[] {
  if (!value || typeof value !== "object") return [];
  const groups = (value as { flatrateGroups?: unknown }).flatrateGroups;
  return Array.isArray(groups) ? groups.filter((group): group is FlatrateGroup => !!group && typeof group === "object") : [];
}

export function findAwSheetGroups(groupsByHg: Map<string, FlatrateGroup[]>) {
  const result = new Map<string, Set<string>>();
  for (const [hg, groups] of groupsByHg) for (const group of groups) for (const rate of group.flatrates ?? []) {
    if (!rate.awSheetOID) continue;
    const hgs = result.get(rate.awSheetOID) ?? new Set<string>();
    hgs.add(hg);
    result.set(rate.awSheetOID, hgs);
  }
  return result;
}
