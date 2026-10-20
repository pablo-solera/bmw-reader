export type ExtractionQueueJob = {
  id: string;
  getState(): Promise<ExtractionQueueJobState>;
  remove(): Promise<void>;
};

export type ExtractionQueueJobState = "pending" | "active" | "completed" | "failed" | "unknown";

export interface ExtractionQueue {
  enqueue(data: Record<string, unknown>, jobId: string): Promise<{ id: string }>;
  getJob(jobId: string): Promise<ExtractionQueueJob | null>;
}

export function isQueueJobPending(state: ExtractionQueueJobState): boolean {
  return state === "active" || state === "pending";
}
