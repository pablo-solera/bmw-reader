import type { LabourState } from "../../domain/labour/labour-state.js";
import type { LabourInput } from "../../domain/labour/types.js";

export type FinishLabourDependencies = {
  getState(requestId: string): Promise<LabourState | null>;
  updateState(requestId: string, patch: Partial<LabourState>): Promise<LabourState | null>;
  releaseTypekeyPaths(requestId: string, paths: string[]): Promise<void>;
  clearPaused(requestId: string): Promise<void>;
  now(): number;
  info(event: string, data: Record<string, unknown>): void;
};

export async function finishLabourUseCase(
  requestId: string,
  input: LabourInput,
  summaries: NonNullable<LabourState["typekeySummary"]>["typekeys"],
  dependencies: FinishLabourDependencies,
) {
  const startedAt = Date.parse((await dependencies.getState(requestId))?.createdAt ?? new Date(dependencies.now()).toISOString());
  await dependencies.updateState(requestId, {
    status: "completed",
    stage: "completed",
    progress: 100,
    error: undefined,
    rateLimitInfo: undefined,
    typekeySummary: { typekeys: summaries, date: input.date, axCode: input.axCode },
  });
  const completedState = await dependencies.getState(requestId);
  if (completedState?.typekeyPaths?.length) await dependencies.releaseTypekeyPaths(requestId, completedState.typekeyPaths);
  await dependencies.updateState(requestId, { typekeyPaths: undefined });
  await dependencies.clearPaused(requestId);
  const durationMs = dependencies.now() - startedAt;
  dependencies.info("extraction_completed", { requestId, durationMs });
  return { kind: "labour", requestId, durationMs };
}
