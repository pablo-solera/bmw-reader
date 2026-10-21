import type { LabourInputBase } from "./input.js";
import type { RequestStatus } from "reader-core/domain/request-status";
export type TypekeyExtractionInput = Omit<LabourInputBase, "date"> & { family: string; edition: string; date?: string };

export type LabourState = {
  requestId: string;
  status: RequestStatus;
  stage: string;
  progress: number | null;
  queueJobId?: string;
  typekeyPaths?: string[];
  input?: TypekeyExtractionInput;
  typekeySummary?: { typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>; date: string; axCode?: string | null };
  rateLimitInfo?: { count: number; cooldownUntil: string; retryAfterMs?: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
};
