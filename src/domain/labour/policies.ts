import type { JobState } from "./job-state.js";
import type { LabourListFilters, LabourListItem } from "./types.js";

export function cancellationDecision(status: JobState["status"] | undefined): "not-found" | "already-cancelled" | "conflict" | "cancel" {
  if (!status) return "not-found";
  if (status === "cancelled" || status === "cancelling") return "already-cancelled";
  if (status === "completed") return "conflict";
  return "cancel";
}

export function resumableTypekeyIndex(entries: Array<{ typekey: string }>, summaries: Array<{ typekey: string; awSheetOIDs: number; remainingAwSheetOIDs: number }>) {
  const summaryByTypekey = new Map(summaries.map(item => [item.typekey, item]));
  const pending = entries.findIndex(entry => {
    const item = summaryByTypekey.get(entry.typekey);
    return !item || item.awSheetOIDs === 0 || item.remainingAwSheetOIDs > 0;
  });
  return pending < 0 ? 0 : pending;
}

export function summarizeLabourList(states: Array<JobState | null>, filters: LabourListFilters = {}): LabourListItem[] {
  return states.flatMap(value => {
    if (!value || value.resource !== "labours" || !value.extractionSummary) return [];
    const axCode = value.extractionSummary.axCode ?? null;
    const edition = value.input?.edition ?? value.extractionSummary.date;
    if (filters.status?.length && !filters.status.includes(value.status)) return [];
    if (filters.axCode !== undefined && axCode !== filters.axCode) return [];
    if (filters.edition !== undefined && edition !== filters.edition) return [];
    if (filters.manufacturer !== undefined && value.input?.manufacturer !== filters.manufacturer) return [];
    return [{
      requestId: value.requestId,
      manufacturer: value.input?.manufacturer ?? "BMW",
      status: value.status,
      stage: value.stage,
      progress: value.progress,
      axCode,
      edition,
      date: value.extractionSummary.date,
      typekeys: value.extractionSummary.typekeys,
      error: ["completed", "cancelled"].includes(value.status) ? null : value.error ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }];
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function isCompletedTypekey(summary: { awSheetOIDs: number; remainingAwSheetOIDs: number }) {
  return summary.awSheetOIDs > 0 && summary.remainingAwSheetOIDs === 0;
}

export function completedTypekeys(summaries: Array<{ typekey: string; awSheetOIDs: number; remainingAwSheetOIDs: number }>) {
  return new Set(summaries.filter(isCompletedTypekey).map(item => item.typekey));
}

export function retryJobStatePatch(currentJobId: string) { return { bullJobId: currentJobId }; }
