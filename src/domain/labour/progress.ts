const CATALOG_WEIGHT = 0.02;
const FLAT_RATES_WEIGHT = 0.08;
const AW_SHEETS_START = CATALOG_WEIGHT + FLAT_RATES_WEIGHT;
const AW_SHEETS_WEIGHT = 0.89;

const ratio = (completed: number, total: number) => total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;

/** Share of one typekey's work (0..0.99) done at a progress event. Downloading AW sheets is the bulk of the time, so it carries most of the weight. */
export function typekeyProgressFraction(stage: string, completed: number, total: number) {
  if (stage === "catalog") return CATALOG_WEIGHT * ratio(completed, total);
  if (stage === "flat-rates-cache" || stage === "flat-rates") return CATALOG_WEIGHT + FLAT_RATES_WEIGHT * ratio(completed, total);
  if (stage === "aw-sheet-details") return AW_SHEETS_START + AW_SHEETS_WEIGHT * ratio(completed, total);
  return 0;
}

/** Overall request progress, capped below 100 (only finishing the request reports 100) and never lower than the progress already stored. */
export function requestProgress(typekeyIndex: number, typekeyCount: number, fraction: number, previous: number | null | undefined) {
  const computed = Math.floor((typekeyIndex + fraction) / typekeyCount * 100);
  return Math.min(99, Math.max(previous ?? 0, computed));
}
