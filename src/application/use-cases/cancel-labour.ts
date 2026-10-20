import type { JobState } from "../../domain/labour/job-state.js";
import { cancellationDecision } from "../../domain/labour/policies.js";
import type { ExtractionQueue } from "../ports/extraction-queue.js";
import { ConflictError, NotFoundError } from "reader-core/domain/errors";

export type CancelLabourDependencies = {
  getState(requestId: string): Promise<JobState | null>;
  hasCancellation(requestId: string): Promise<boolean>;
  requestCancellation(requestId: string): Promise<void>;
  persistCancelling(state: JobState): Promise<void>;
  queue: Pick<ExtractionQueue, "getJob">;
  abortActive(requestId: string): void;
  finalize(requestId: string, state: JobState): Promise<{ cleanup: unknown[]; cleanupError?: string; pending?: boolean }>;
  log(event: string, data: Record<string, unknown>): void;
};

export async function cancelLabourUseCase(requestId: string, dependencies: CancelLabourDependencies) {
  const current = await dependencies.getState(requestId);
  const decision = cancellationDecision(current?.status);
  if (decision === "not-found") throw new NotFoundError("Labour request not found", { requestId });
  if (decision === "conflict") throw new ConflictError("Completed labour requests cannot be cancelled", { requestId });
  if (decision === "already-cancelled") return { requestId, status: current!.status };
  if (await dependencies.hasCancellation(requestId)) return { requestId, status: "cancelling" as const };

  await dependencies.requestCancellation(requestId);
  const cancelling: JobState = { ...current!, status: "cancelling", stage: "cancelling" };
  await dependencies.persistCancelling(cancelling);
  const job = current!.bullJobId ? await dependencies.queue.getJob(current!.bullJobId) : null;
  const jobState = job ? await job.getState() : "unknown";
  dependencies.abortActive(requestId);
  if (job && jobState === "active") {
    dependencies.log("extraction_cancel_requested", { requestId, active: true });
    return { requestId, status: "cancelling" as const };
  }

  dependencies.log("extraction_cancel_requested", { requestId, active: false });
  if (job && ["pending", "failed"].includes(jobState)) {
    try { await job.remove(); }
    catch (error) { dependencies.log("cancel_job_remove_failed", { requestId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const racedJob = current!.bullJobId ? await dependencies.queue.getJob(current!.bullJobId) : null;
  if (racedJob && await racedJob.getState() === "active") {
    dependencies.abortActive(requestId);
    dependencies.log("extraction_cancel_requested", { requestId, active: true, raced: true });
    return { requestId, status: "cancelling" as const };
  }

  const result = await dependencies.finalize(requestId, current!);
  if (result.pending) return { requestId, status: "cancelling" as const };
  return { requestId, status: "cancelled" as const, ...result };
}
