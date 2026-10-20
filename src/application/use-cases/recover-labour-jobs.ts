import type { JobState } from "../../types.js";
import { isBullMqJobPending } from "../../domain/labour/policies.js";

type LabourRecoveryDependencies = {
  getIndexedRequestIds(): Promise<string[]>;
  getState(requestId: string): Promise<JobState | null>;
  getQueueJobState(state: JobState): Promise<string | null>;
};

export type ResumeOrphanedLabourDependencies = LabourRecoveryDependencies & {
  getPausedRequestIds(): Promise<string[]>;
  resume(requestId: string): Promise<unknown>;
  warn(event: string, requestId: string, error: unknown): void;
};

export type RecoverCancelledLabourDependencies = LabourRecoveryDependencies & {
  finalizeCancellation(requestId: string, state: JobState): Promise<unknown>;
};

const resumableStatuses = new Set(["downloading", "queued", "rate-limited", "paused"]);

export async function resumeOrphanedLabourJobs(dependencies: ResumeOrphanedLabourDependencies): Promise<number> {
  const requestIds = new Set(await dependencies.getPausedRequestIds());
  for (const requestId of await dependencies.getIndexedRequestIds()) {
    const current = await dependencies.getState(requestId);
    if (current && resumableStatuses.has(current.status)) requestIds.add(requestId);
  }

  const resumed = new Set<string>();
  for (const requestId of requestIds) {
    const current = await dependencies.getState(requestId);
    if (!current || !resumableStatuses.has(current.status)) continue;
    const jobState = await dependencies.getQueueJobState(current);
    if (jobState && isBullMqJobPending(jobState)) {
      resumed.add(requestId);
      continue;
    }
    try {
      await dependencies.resume(requestId);
      resumed.add(requestId);
    } catch (error) {
      dependencies.warn("orphan_job_resume_skipped", requestId, error);
    }
  }
  return resumed.size;
}

export async function recoverCancelledLabourJobs(dependencies: RecoverCancelledLabourDependencies): Promise<number> {
  let recovered = 0;
  for (const requestId of await dependencies.getIndexedRequestIds()) {
    const current = await dependencies.getState(requestId);
    if (!current || current.status !== "cancelling") continue;
    const jobState = await dependencies.getQueueJobState(current);
    if (jobState === "active") continue;
    await dependencies.finalizeCancellation(requestId, current);
    recovered++;
  }
  return recovered;
}
