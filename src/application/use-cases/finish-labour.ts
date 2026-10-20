import type { JobState } from "../../types.js";
import type { LabourInput } from "../../domain/labour/types.js";

export type FinishLabourDependencies = {
  getState(requestId: string): Promise<JobState | null>;
  updateState(requestId: string, patch: Partial<JobState>): Promise<JobState | null>;
  releaseTypekeyPaths(requestId: string, paths: string[]): Promise<void>;
  clearPaused(requestId: string): Promise<void>;
  now(): number;
  info(event: string, data: Record<string, unknown>): void;
};

export async function finishLabourUseCase(
  requestId: string,
  input: LabourInput,
  summaries: NonNullable<JobState["extractionSummary"]>["typekeys"],
  dependencies: FinishLabourDependencies,
) {
  const startedAt = Date.parse((await dependencies.getState(requestId))?.createdAt ?? new Date(dependencies.now()).toISOString());
  await dependencies.updateState(requestId, {
    status: "completed",
    stage: "completed",
    progress: 100,
    resource: "labours",
    error: undefined,
    rateLimitInfo: undefined,
    extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode },
  });
  const completedState = await dependencies.getState(requestId);
  if (completedState?.typekeyPaths?.length) await dependencies.releaseTypekeyPaths(requestId, completedState.typekeyPaths);
  await dependencies.updateState(requestId, { typekeyPaths: undefined });
  await dependencies.clearPaused(requestId);
  const durationMs = dependencies.now() - startedAt;
  dependencies.info("extraction_completed", { requestId, durationMs });
  return { kind: "extraction", requestId, durationMs };
}
