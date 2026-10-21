import type { LabourQueueState } from "../../application/ports/labour-queue.js";

export const LABOUR_QUEUE_NAME = "bmw-labour-typekeys";

export const LABOUR_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 2,
  backoff: { type: "exponential", delay: 30000 },
  ignoreDependencyOnFailure: true,
} as const;

export function toLabourQueueState(state: string): LabourQueueState {
  if (state === "active") return "active";
  if (["waiting", "delayed", "prioritized", "waiting-children"].includes(state)) return "pending";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "unknown";
}
