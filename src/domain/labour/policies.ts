import type { RequestStatus } from "@solera/core-reader/domain/request-status";

export function cancellationDecision(status: RequestStatus | undefined): "not-found" | "already-cancelled" | "conflict" | "cancel" {
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

export function isCompletedTypekey(summary: { awSheetOIDs: number; remainingAwSheetOIDs: number }) {
  return summary.awSheetOIDs > 0 && summary.remainingAwSheetOIDs === 0;
}

export function completedTypekeys(summaries: Array<{ typekey: string; awSheetOIDs: number; remainingAwSheetOIDs: number }>) {
  return new Set(summaries.filter(isCompletedTypekey).map(item => item.typekey));
}
