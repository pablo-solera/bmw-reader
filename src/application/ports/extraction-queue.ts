export type ExtractionQueueJob = {
  id: string;
  getState(): Promise<string>;
  remove(): Promise<void>;
};

export interface ExtractionQueue {
  add(name: string, data: Record<string, unknown>, options: Record<string, unknown>): Promise<{ id: string }>;
  getJob(jobId: string): Promise<ExtractionQueueJob | null>;
}

export function isQueueJobPending(state: string): boolean {
  return state === "active" || state === "waiting" || state === "delayed";
}
