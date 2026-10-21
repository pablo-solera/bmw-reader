export type LabourQueueJob = {
  id: string;
  getState(): Promise<LabourQueueState>;
  remove(): Promise<void>;
};

export type LabourQueueState = "pending" | "active" | "completed" | "failed" | "unknown";

/** Queue port for sequential BMW typekey work. */
export interface LabourQueue {
  enqueue(data: Record<string, unknown>, jobId: string): Promise<{ id: string }>;
  getJob(jobId: string): Promise<LabourQueueJob | null>;
}

export function isQueueJobPending(state: LabourQueueState): boolean {
  return state === "active" || state === "pending";
}
