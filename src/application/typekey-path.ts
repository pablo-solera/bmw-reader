import type { LabourInput } from "../domain/labour/types.js";
import { resolveModelSeries } from "../domain/labour/series.js";

export function relativeTypekeyPath(group: string, manufacturer: string, series: string, family: string, date: string, typekey: string): string {
  return [group, manufacturer, "labour", resolveModelSeries(series), family, date, typekey].join("/");
}

export function typekeyPathForJob(input: LabourInput, index: number): string | null {
  const entry = input.typekeys[index];
  if (!entry) return null;
  try { return relativeTypekeyPath("BMW", input.manufacturer, resolveModelSeries(entry.series, input.series), entry.family, input.date, entry.typekey); }
  catch { return null; }
}

export function incompleteTypekeysForCleanup(input: LabourInput, completedPaths: Set<string>) {
  return input.typekeys.flatMap((entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path && !completedPaths.has(path) ? [{ entry, path }] : [];
  });
}
