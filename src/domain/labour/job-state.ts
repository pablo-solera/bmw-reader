import type { LabourInputBase } from "./input.js";
export type ExtractionInput = Omit<LabourInputBase, "date"> & { family: string; edition: string; date?: string };

export type JobStatus = "queued" | "downloading" | "rate-limited" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";

export type JobState = {
  requestId: string;
  status: JobStatus;
  stage: string;
  progress: number | null;
  bullJobId?: string;
  typekeyPaths?: string[];
  input?: ExtractionInput;
  extractionSummary?: { typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>; date: string; axCode?: string | null };
  rateLimitInfo?: { count: number; cooldownUntil: string; retryAfterMs?: number };
  resource?: "labours";
  error?: string;
  createdAt: string;
  updatedAt: string;
};
