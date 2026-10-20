import type { JobState } from "../../domain/labour/job-state.js";
import type { LabourInput } from "../../domain/labour/types.js";

export type FinalizeCancelledLabourDependencies = {
  updateState(requestId: string, patch: Partial<JobState>): Promise<JobState | null>;
  cleanup(requestId: string, input: LabourInput): Promise<Array<{ typekey: string; deletedObjects: number; skipped: boolean }>>;
  clearPaused(requestId: string): Promise<void>;
  clearCancellationState(requestId: string): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
};

export async function finalizeCancelledLabourUseCase(
  requestId: string,
  current: JobState,
  dependencies: FinalizeCancelledLabourDependencies,
) {
  const saved = current.input;
  const summary = current.extractionSummary;
  if (!saved || !summary) throw new Error(`Cannot clean cancelled labour ${requestId}: extraction input or summary is missing`);
  const cleanupInput: LabourInput = {
    manufacturer: saved.manufacturer,
    series: saved.series,
    model: saved.model,
    axCode: summary.axCode ?? undefined,
    edition: saved.edition,
    date: summary.date,
    language: saved.language,
    typekeys: summary.typekeys.map(item => ({ typekey: item.typekey, series: item.series, family: item.family, model: item.model })),
  };

  let cleanup: Awaited<ReturnType<FinalizeCancelledLabourDependencies["cleanup"]>> = [];
  let cleanupError: string | undefined;
  try { cleanup = await dependencies.cleanup(requestId, cleanupInput); }
  catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
  await dependencies.updateState(requestId, {
    status: "cancelled",
    stage: "cancelled",
    progress: current.progress,
    error: cleanupError ? `Cancellation cleanup failed: ${cleanupError}` : undefined,
  });
  await dependencies.clearPaused(requestId);
  await dependencies.clearCancellationState(requestId);
  dependencies.log("extraction_cancelled", { requestId, cleanup, cleanupError });
  return { cleanup, cleanupError };
}
