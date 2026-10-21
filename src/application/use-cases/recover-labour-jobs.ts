import type { LabourState } from "../../domain/labour/labour-state.js";
import { isQueueJobPending, type LabourQueueState } from "../ports/labour-queue.js";
import { mapConcurrent } from "reader-core/shared/concurrency";

type LabourRecoveryDependencies = {
  getIndexedRequestIds(): Promise<string[]>;
  getStates(requestIds: string[]): Promise<Array<LabourState | null>>;
  getQueueLabourState(state: LabourState): Promise<LabourQueueState | null>;
};

export type ResumeOrphanedLabourDependencies = LabourRecoveryDependencies & {
  getPausedRequestIds(): Promise<string[]>;
  resume(requestId: string): Promise<unknown>;
  warn(event: string, requestId: string, error: unknown): void;
};

export type RecoverCancelledLabourDependencies = LabourRecoveryDependencies & {
  finalizeCancellation(requestId: string, state: LabourState): Promise<unknown>;
};

const resumableStatuses = new Set(["running", "queued", "rate_limited", "paused"]);

export async function resumeOrphanedLabourJobs(dependencies: ResumeOrphanedLabourDependencies): Promise<number> {
  const [pausedIds, indexedIds] = await Promise.all([dependencies.getPausedRequestIds(), dependencies.getIndexedRequestIds()]);
  const requestIds = [...new Set([...pausedIds, ...indexedIds])];
  const states = await dependencies.getStates(requestIds);
  const candidates = requestIds.flatMap((requestId, index) => {
    const current = states[index];
    return current && resumableStatuses.has(current.status) ? [{ requestId, current }] : [];
  });
  const outcomes = await mapConcurrent(candidates, 8, async ({ requestId, current }) => {
    const jobState = await dependencies.getQueueLabourState(current);
    if (jobState && isQueueJobPending(jobState)) return true;
    try {
      await dependencies.resume(requestId);
      return true;
    } catch (error) {
      dependencies.warn("orphan_job_resume_skipped", requestId, error);
      return false;
    }
  });
  return outcomes.filter(Boolean).length;
}

export async function recoverCancelledLabourJobs(dependencies: RecoverCancelledLabourDependencies): Promise<number> {
  const requestIds = await dependencies.getIndexedRequestIds();
  const states = await dependencies.getStates(requestIds);
  const candidates = requestIds.flatMap((requestId, index) => {
    const current = states[index];
    return current?.status === "cancelling" ? [{ requestId, current }] : [];
  });
  const results = await mapConcurrent(candidates, 8, async ({ requestId, current }) => {
    const jobState = await dependencies.getQueueLabourState(current);
    if (jobState === "active") return false;
    await dependencies.finalizeCancellation(requestId, current);
    return true;
  });
  return results.filter(Boolean).length;
}
