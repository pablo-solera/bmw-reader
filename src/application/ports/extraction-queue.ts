export type ExtractionQueueJob = {
  id: string;
  getState(): Promise<ExtractionQueueLabourState>;
  remove(): Promise<void>;
};

export type ExtractionQueueLabourState = "pending" | "active" | "completed" | "failed" | "unknown";

export interface ExtractionQueue {
  enqueue(data: Record<string, unknown>, jobId: string): Promise<{ id: string }>;
  getJob(jobId: string): Promise<ExtractionQueueJob | null>;
}

export function isQueueJobPending(state: ExtractionQueueLabourState): boolean {
  return state === "active" || state === "pending";
}
