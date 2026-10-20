import type { ExtractionInput, JobState } from "../../types.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { completedTypekeys, resumableTypekeyIndex, typekeyPathForJob } from "../../domain/labour/policies.js";
import type { ExtractionQueue } from "../ports/extraction-queue.js";
import { createExtractionJobId } from "../../domain/labour/job-id.js";
import { ConflictError, NotFoundError } from "reader-core/domain/errors";
import { isQueueJobPending } from "../ports/extraction-queue.js";
import { EXTRACTION_JOB_OPTIONS, EXTRACTION_QUEUE_NAME } from "../ports/extraction-queue-policy.js";

export type ResumeLabourDependencies = {
  getState(requestId: string): Promise<JobState | null>;
  updateState(requestId: string, patch: Partial<JobState>): Promise<JobState | null>;
  getHeartbeatTtl(requestId: string): Promise<number>;
  workerIsActive(): Promise<boolean>;
  workerShuttingDown(): boolean;
  queue: Pick<ExtractionQueue, "getJob" | "add">;
  claimTypekeyPaths(requestId: string, input: LabourInput): Promise<string[]>;
  releaseTypekeyPaths(requestId: string, paths: string[]): Promise<void>;
  clearPaused(requestId: string): Promise<void>;
  newId(): string;
};

export async function resumeLabourUseCase(requestId: string, dependencies: ResumeLabourDependencies, force = false, startupRecovery = false) {
  const current = await dependencies.getState(requestId);
  if (!current || current.resource !== "labours" || !current.input || !current.extractionSummary) throw new NotFoundError("Resumable extraction not found", { requestId });
  if (current.status === "cancelled" || current.status === "cancelling") throw new ConflictError("Cancelled extractions cannot be resumed", { requestId, status: current.status });
  const heartbeat = await dependencies.getHeartbeatTtl(requestId);
  if (force && !startupRecovery && !dependencies.workerShuttingDown() && await dependencies.workerIsActive()) throw new ConflictError("Force resume is disabled while a worker is active", { requestId });
  if (!["failed", "downloading", "queued", "paused", "rate-limited"].includes(current.status)) throw new ConflictError(`Extraction is not resumable (current status: ${current.status})`, { requestId, status: current.status });
  if (heartbeat > 0 && !force && !startupRecovery && current.status === "downloading") throw new ConflictError("Extraction is currently active", { requestId });

  const existingJob = current.bullJobId ? await dependencies.queue.getJob(current.bullJobId) : null;
  if (existingJob) {
    const existingJobState = await existingJob.getState();
    if (isQueueJobPending(existingJobState)) throw new ConflictError("Extraction already has a queued or active job", { requestId });
    if (["failed", "completed"].includes(existingJobState)) await existingJob.remove().catch(() => undefined);
  }

  const savedInput = current.input as ExtractionInput;
  const entries = current.extractionSummary.typekeys.map(({ typekey, series, family, model }) => ({ typekey, series, family, ...(model ? { model } : {}) }));
  const labourInput: LabourInput = {
    manufacturer: savedInput.manufacturer,
    model: savedInput.model,
    axCode: savedInput.axCode,
    edition: savedInput.edition,
    date: current.extractionSummary.date,
    language: savedInput.language,
    typekeys: entries,
  };
  const runId = dependencies.newId();
  const resumeAt = resumableTypekeyIndex(entries, current.extractionSummary.typekeys);
  const jobId = createExtractionJobId(requestId, runId, resumeAt);
  const completeIds = completedTypekeys(current.extractionSummary.typekeys);
  const pendingInput: LabourInput = { ...labourInput, typekeys: entries.filter(entry => !completeIds.has(entry.typekey)) };
  const pathsToClaim = pendingInput.typekeys.map((_entry, index) => typekeyPathForJob(pendingInput, index)).filter((path): path is string => Boolean(path));
  const newClaims = pathsToClaim.length ? await dependencies.claimTypekeyPaths(requestId, pendingInput) : [];
  const claimedPaths = [...(current.typekeyPaths ?? []), ...newClaims];
  await dependencies.updateState(requestId, { resource: "labours", typekeyPaths: claimedPaths, status: "queued", stage: "queued", progress: current.progress ?? 0, error: undefined, bullJobId: jobId });
  await dependencies.clearPaused(requestId);
  try {
    const typekeyPaths = labourInput.typekeys.map((_entry, index) => typekeyPathForJob(labourInput, index)).filter((path): path is string => Boolean(path));
    await dependencies.queue.add("extract", { requestId, input: labourInput, index: resumeAt, runId, replacementAttempt: true, typekeyPaths }, {
      jobId,
      ...EXTRACTION_JOB_OPTIONS,
    });
  } catch (error) {
    await dependencies.updateState(requestId, { bullJobId: current.bullJobId, status: current.status, stage: current.stage, error: current.error });
    if (newClaims.length) await dependencies.releaseTypekeyPaths(requestId, newClaims);
    throw error;
  }
  return { requestId, resumedAtTypekey: entries[resumeAt]?.typekey ?? entries[0]?.typekey, queue: EXTRACTION_QUEUE_NAME };
}
