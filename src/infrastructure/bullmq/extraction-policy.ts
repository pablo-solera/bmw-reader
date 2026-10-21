import type { ExtractionQueueLabourState } from "../../application/ports/extraction-queue.js";

export const EXTRACTION_QUEUE_NAME = "bmw-extractions";

export const EXTRACTION_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 2,
  backoff: { type: "exponential", delay: 30000 },
  ignoreDependencyOnFailure: true,
} as const;

export function toExtractionQueueLabourState(state: string): ExtractionQueueLabourState {
  if (state === "active") return "active";
  if (["waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return "pending";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "unknown";
}
