import type { LabourState } from "../../domain/labour/labour-state.js";
import { completedTypekeys } from "../../domain/labour/policies.js";
import { typekeyPathForJob } from "../typekey-path.js";
import { validateLabourInput } from "../../domain/labour/validation.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { isQueueJobPending, type LabourQueue } from "../ports/labour-queue.js";
import { ConflictError } from "@solera/core-reader/domain/errors";
import { createLabourTypekeyJobId } from "../../domain/labour/labour-job-id.js";

export type EnqueueLabourDependencies = {
  getState(requestId: string): Promise<LabourState | null>;
  saveState(state: LabourState, index: boolean): Promise<LabourState>;
  deleteState(requestId: string): Promise<void>;
  claimTypekeyPaths(requestId: string, input: LabourInput): Promise<string[]>;
  releaseTypekeyPaths(requestId: string, paths: string[]): Promise<void>;
  isCancelling(requestId: string): Promise<boolean>;
  queue: Pick<LabourQueue, "enqueue" | "getJob">;
  assertTypekeysAvailable?(typekeys: string[], language: string | undefined): Promise<void>;
  newId(): string;
  now(): Date;
};

export type EnqueueLabourRequest = Omit<LabourInput, "date"> & { date?: string };

export async function enqueueLabourUseCase(input: EnqueueLabourRequest, dependencies: EnqueueLabourDependencies, resumeAt = 0, requestId = dependencies.newId()) {
  const normalizedInput = validateLabourInput({
    ...input,
    date: input.date ?? dependencies.now().toISOString().slice(0, 10).replace(/-/g, ""),
  });
  const previousState = await dependencies.getState(requestId);
  if (!previousState) await dependencies.assertTypekeysAvailable?.(normalizedInput.typekeys.map(item => item.typekey), normalizedInput.language);
  if (previousState) {
    if (previousState.status === "cancelled" || previousState.status === "cancelling") throw new ConflictError("Cancelled labour requests are final; submit a new request ID");
    if (!new Set(["failed", "paused"]).has(previousState.status)) throw new ConflictError(`Request ID already exists with status ${previousState.status}`);
    const completed = completedTypekeys(previousState.typekeySummary?.typekeys ?? []);
    const nextIndex = normalizedInput.typekeys.findIndex(item => !completed.has(item.typekey));
    resumeAt = nextIndex < 0 ? normalizedInput.typekeys.length - 1 : nextIndex;
  }
  const replacementAttempt = Boolean(previousState);
  const completedTypekeyIds = completedTypekeys(previousState?.typekeySummary?.typekeys ?? []);
  const pendingEntries = normalizedInput.typekeys.filter(item => !completedTypekeyIds.has(item.typekey));
  const pendingInput: LabourInput = { ...normalizedInput, typekeys: pendingEntries };
  const pathsToClaim = pendingEntries.map((_entry, index) => typekeyPathForJob(pendingInput, index)).filter((path): path is string => Boolean(path));
  const newClaims = pathsToClaim.length ? await dependencies.claimTypekeyPaths(requestId, pendingInput) : [];
  const claimedPaths = [...(previousState?.typekeyPaths ?? []), ...newClaims];
  if (await dependencies.isCancelling(requestId)) {
    if (newClaims.length) await dependencies.releaseTypekeyPaths(requestId, newClaims);
    throw new ConflictError("This labour request is being cancelled and cannot be re-enqueued");
  }
  if (previousState?.queueJobId) {
    const existing = await dependencies.queue.getJob(previousState.queueJobId);
    if (existing && isQueueJobPending(await existing.getState())) {
      if (newClaims.length) await dependencies.releaseTypekeyPaths(requestId, newClaims);
      throw new ConflictError("Extraction already has a queued or active job");
    }
  }

  const now = dependencies.now().toISOString();
  const initial: LabourState = {
    requestId,
    status: "queued",
    stage: "queued",
    progress: 0,
    input: {
      manufacturer: normalizedInput.manufacturer,
      series: normalizedInput.typekeys[0]?.series,
      model: normalizedInput.model ?? normalizedInput.typekeys[0]?.model,
      family: normalizedInput.typekeys[0]?.family ?? "",
      axCode: normalizedInput.axCode,
      edition: normalizedInput.edition ?? normalizedInput.date,
      date: normalizedInput.date,
      language: normalizedInput.language,
    },
    typekeyPaths: claimedPaths,
    typekeySummary: {
      typekeys: normalizedInput.typekeys.map(item => ({ ...item, hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 })),
      date: normalizedInput.date,
      axCode: normalizedInput.axCode,
    },
    createdAt: now,
    updatedAt: now,
  };
  const runId = dependencies.newId();
  const jobId = createLabourTypekeyJobId(requestId, runId, resumeAt);
  initial.queueJobId = jobId;
  await dependencies.saveState(initial, true);
  try {
    const typekeyPaths = normalizedInput.typekeys.map((_entry, index) => typekeyPathForJob(normalizedInput, index)).filter((path): path is string => Boolean(path));
    await dependencies.queue.enqueue({ requestId, input: normalizedInput, index: resumeAt, runId, replacementAttempt, typekeyPaths }, jobId);
  } catch (error) {
    await dependencies.deleteState(requestId);
    if (newClaims.length) await dependencies.releaseTypekeyPaths(requestId, newClaims);
    throw error;
  }
  return requestId;
}
