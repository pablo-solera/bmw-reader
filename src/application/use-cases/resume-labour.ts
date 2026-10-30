import type { LabourState } from "../../domain/labour/labour-state.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { completedTypekeys, resumableTypekeyIndex } from "../../domain/labour/policies.js";
import { typekeyPathForJob } from "../typekey-path.js";
import type { LabourQueue } from "../ports/labour-queue.js";
import { createLabourTypekeyJobId } from "../../domain/labour/labour-job-id.js";
import { ConflictError, NotFoundError } from "@pablosla/core-reader/domain/errors";
import { isQueueJobPending } from "../ports/labour-queue.js";

export type ResumeLabourDependencies = {
  getState(requestId: string): Promise<LabourState | null>;
  updateState(requestId: string, patch: Partial<LabourState>): Promise<LabourState | null>;
  getHeartbeatTtl(requestId: string): Promise<number>;
  workerIsActive(): Promise<boolean>;
  workerShuttingDown(): boolean;
  queue: Pick<LabourQueue, "getJob" | "enqueue">;
  queueName: string;
  claimTypekeyPaths(requestId: string, input: LabourInput): Promise<string[]>;
  releaseTypekeyPaths(requestId: string, paths: string[]): Promise<void>;
  clearPaused(requestId: string): Promise<void>;
  newId(): string;
};

export async function resumeLabourUseCase(requestId: string, dependencies: ResumeLabourDependencies, force = false, startupRecovery = false) {
  const current = await dependencies.getState(requestId);
  if (!current || !current.input || !current.typekeySummary) throw new NotFoundError("Resumable extraction not found", { requestId });
  if (current.status === "cancelled" || current.status === "cancelling") throw new ConflictError("Cancelled extractions cannot be resumed", { requestId, status: current.status });
  const heartbeat = await dependencies.getHeartbeatTtl(requestId);
  if (force && !startupRecovery && !dependencies.workerShuttingDown() && await dependencies.workerIsActive()) throw new ConflictError("Force resume is disabled while a worker is active", { requestId });
  if (!["failed", "running", "queued", "paused", "rate_limited"].includes(current.status)) throw new ConflictError(`Extraction is not resumable (current status: ${current.status})`, { requestId, status: current.status });
  if (heartbeat > 0 && !force && !startupRecovery && current.status === "running") throw new ConflictError("Extraction is currently active", { requestId });

  const existingJob = current.queueJobId ? await dependencies.queue.getJob(current.queueJobId) : null;
  if (existingJob) {
    const existingLabourState = await existingJob.getState();
    if (isQueueJobPending(existingLabourState)) throw new ConflictError("Extraction already has a queued or active job", { requestId });
    if (["failed", "completed"].includes(existingLabourState)) await existingJob.remove().catch(() => undefined);
  }

  const savedInput = current.input;
  const entries = current.typekeySummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) }));
  const labourInput: LabourInput = {
    manufacturer: savedInput.manufacturer,
    model: savedInput.model,
    axCode: savedInput.axCode,
    edition: savedInput.edition,
    date: current.typekeySummary.date,
    language: savedInput.language,
    typekeys: entries,
  };
  const runId = dependencies.newId();
  const resumeAt = resumableTypekeyIndex(entries, current.typekeySummary.typekeys);
  const jobId = createLabourTypekeyJobId(requestId, runId, resumeAt);
  const completeIds = completedTypekeys(current.typekeySummary.typekeys);
  const pendingInput: LabourInput = { ...labourInput, typekeys: entries.filter(entry => !completeIds.has(entry.typekey)) };
  const pathsToClaim = pendingInput.typekeys.map((_entry, index) => typekeyPathForJob(pendingInput, index)).filter((path): path is string => Boolean(path));
  const newClaims = pathsToClaim.length ? await dependencies.claimTypekeyPaths(requestId, pendingInput) : [];
  const claimedPaths = [...(current.typekeyPaths ?? []), ...newClaims];
  await dependencies.updateState(requestId, { typekeyPaths: claimedPaths, status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined, queueJobId: jobId });
  await dependencies.clearPaused(requestId);
  try {
    const typekeyPaths = labourInput.typekeys.map((_entry, index) => typekeyPathForJob(labourInput, index)).filter((path): path is string => Boolean(path));
    await dependencies.queue.enqueue({ requestId, input: labourInput, index: resumeAt, runId, replacementAttempt: true, typekeyPaths }, jobId);
  } catch (error) {
    await dependencies.updateState(requestId, { queueJobId: current.queueJobId, status: current.status, stage: current.stage, error: current.error });
    if (newClaims.length) await dependencies.releaseTypekeyPaths(requestId, newClaims);
    throw error;
  }
  return { requestId, resumedAtTypekey: entries[resumeAt]?.typekey ?? entries[0]?.typekey, queue: dependencies.queueName };
}
