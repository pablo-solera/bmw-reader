import type { JobState } from "../../types.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { retryJobStatePatch } from "../../domain/labour/policies.js";
import { createExtractionJobId } from "../../domain/labour/job-id.js";
import { TypekeyCancelledError, TypekeyOidFailuresError } from "../../domain/labour/errors.js";

export type TypekeyJobAttempt = { attemptsMade: number; attempts: number; id?: string };

export function isUnrecoverableTypekeyFailure(error: unknown) {
  return error instanceof Error && (
    ("retryWindowExhausted" in error && error.retryWindowExhausted === true) ||
    error instanceof TypekeyOidFailuresError ||
    error instanceof TypekeyCancelledError
  );
}

export type TypekeyDownloadResult = {
  paused?: boolean;
  hgs: number;
  awSheetOIDs: number;
  completedAwSheetOIDs: number;
  remainingAwSheetOIDs: number;
  failedOids?: Record<string, unknown>;
};

export type ProcessLabourTypekeyDependencies = {
  download(input: LabourInput, index: number, requestId: string, runId: string, replacementAttempt: boolean, onProgress: (event: { stage: string; completed: number; total: number; detail?: string; failed?: number; hgs?: number }) => Promise<void>): Promise<TypekeyDownloadResult>;
  getState(requestId: string): Promise<JobState | null>;
  updateState(requestId: string, patch: Partial<JobState>, ifMatches?: Partial<JobState>): Promise<JobState | null>;
  finalizeCancellation(requestId: string, state: JobState): Promise<unknown>;
  isCancellationRequested(requestId: string): Promise<boolean>;
  isShuttingDown(): boolean;
  isCancelledError(error: unknown): boolean;
  addPaused(requestId: string): Promise<void>;
  releaseCompletedPath(requestId: string, input: LabourInput, typekey: string): Promise<void>;
  queueNext(requestId: string, input: LabourInput, index: number, runId: string, jobId: string): Promise<void>;
  finish(requestId: string, input: LabourInput, summaries: NonNullable<JobState["extractionSummary"]>["typekeys"]): Promise<unknown>;
  releasePaths(requestId: string, paths: string[]): Promise<void>;
  now(): number;
  info(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
  makeUnrecoverable(message: string, cause: unknown): Error;
};

export async function processLabourTypekeyUseCase(
  job: TypekeyJobAttempt,
  requestId: string,
  input: LabourInput,
  index: number,
  runId: string,
  replacementAttempt: boolean,
  dependencies: ProcessLabourTypekeyDependencies,
) {
  const entry = input.typekeys[index];
  if (!entry) throw new Error(`Missing model typekey at index ${index}`);
  if (await dependencies.isCancellationRequested(requestId)) {
    const current = await dependencies.getState(requestId);
    if (current) await dependencies.finalizeCancellation(requestId, current);
    return { kind: "cancelled", requestId };
  }

  const startedAt = dependencies.now();
  let currentHgs = 0;
  let progressQueue = Promise.resolve();
  try {
    const result = await dependencies.download(input, index, requestId, runId, replacementAttempt, event => {
      const update = progressQueue.then(async () => {
      if (event.stage !== "aw-sheet-details") await dependencies.updateState(requestId, { rateLimitInfo: undefined });
      const current = await dependencies.getState(requestId);
      const existing = current?.extractionSummary?.typekeys ?? [];
      currentHgs = event.hgs ?? currentHgs;
      const summary = {
        typekey: entry.typekey,
        series: entry.series ?? input.series,
        family: entry.family,
        model: entry.model ?? input.model,
        hgs: currentHgs,
        awSheetOIDs: event.total,
        completedAwSheetOIDs: event.completed,
        remainingAwSheetOIDs: Math.max(0, event.total - event.completed),
        failedOids: event.failed ?? 0,
      };
      const cancelling = await dependencies.isCancellationRequested(requestId);
      const nextStatus = cancelling ? "cancelling" : dependencies.isShuttingDown() && event.stage === "aw-sheet-details" ? "paused" : "downloading";
      await dependencies.updateState(requestId, {
        status: nextStatus,
        stage: cancelling ? `${entry.typekey}:cancelling` : nextStatus === "paused" ? `${entry.typekey}:pausing` : `${entry.typekey}:${event.stage}`,
        progress: Math.min(99, Math.floor(index / input.typekeys.length * 100 + (event.total ? event.completed / event.total : 0) * (100 / input.typekeys.length))),
        extractionSummary: { typekeys: [...existing.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode },
      }, current ? { status: current.status } : {});
      if (event.stage === "aw-sheet-details") dependencies.info("typekey_progress", { requestId, typekey: entry.typekey, completed: event.completed, total: event.total, failed: event.failed ?? 0 });
      });
      progressQueue = update.catch(() => undefined);
      return update;
    });

    if (await dependencies.isCancellationRequested(requestId)) {
      const current = await dependencies.getState(requestId);
      if (current) await dependencies.finalizeCancellation(requestId, current);
      return { kind: "cancelled", requestId, typekey: entry.typekey };
    }
    const current = await dependencies.getState(requestId);
    const summariesBefore = current?.extractionSummary?.typekeys ?? [];
    if (result.paused) {
      const summary = { typekey: entry.typekey, series: entry.series ?? input.series, family: entry.family, model: entry.model ?? input.model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: result.remainingAwSheetOIDs, failedOids: Object.keys(result.failedOids ?? {}).length };
      await dependencies.updateState(requestId, { status: "paused", stage: `${entry.typekey}:paused`, extractionSummary: { typekeys: [...summariesBefore.filter(item => item.typekey !== entry.typekey), summary], date: input.date, axCode: input.axCode } });
      await dependencies.addPaused(requestId);
      dependencies.info("extraction_paused", { requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs });
      return { kind: "paused", requestId, typekey: entry.typekey, remaining: result.remainingAwSheetOIDs };
    }

    dependencies.info("typekey_completed", { requestId, typekey: entry.typekey, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, durationMs: dependencies.now() - startedAt });
    await dependencies.releaseCompletedPath(requestId, input, entry.typekey);
    const summaries = [...(current?.extractionSummary?.typekeys ?? []).filter(item => item.typekey !== entry.typekey), { typekey: entry.typekey, series: entry.series ?? input.series, family: entry.family, model: entry.model ?? input.model, hgs: result.hgs, awSheetOIDs: result.awSheetOIDs, completedAwSheetOIDs: result.completedAwSheetOIDs, remainingAwSheetOIDs: 0, failedOids: 0 }];
    if (index + 1 < input.typekeys.length) {
      const nextJobId = createExtractionJobId(requestId, runId, index + 1);
      await dependencies.updateState(requestId, { status: "downloading", progress: Math.floor((index + 1) / input.typekeys.length * 100), stage: `${entry.typekey}:completed`, extractionSummary: { typekeys: summaries, date: input.date, axCode: input.axCode }, bullJobId: nextJobId });
      await dependencies.queueNext(requestId, input, index + 1, runId, nextJobId);
      return { kind: "typekey", requestId, typekey: entry.typekey, nextTypekey: input.typekeys[index + 1]!.typekey };
    }
    return dependencies.finish(requestId, input, summaries);
  } catch (error) {
    if (dependencies.isCancelledError(error) || await dependencies.isCancellationRequested(requestId)) {
      const current = await dependencies.getState(requestId);
      if (current) await dependencies.finalizeCancellation(requestId, current);
      return { kind: "cancelled", requestId, typekey: entry.typekey };
    }
    const unrecoverable = isUnrecoverableTypekeyFailure(error);
    const retrying = !unrecoverable && job.attemptsMade + 1 < job.attempts;
    const lastState = await dependencies.getState(requestId);
    await dependencies.updateState(requestId, { status: retrying ? "queued" : "failed", stage: retrying ? `${entry.typekey}:retrying` : "failed", progress: lastState?.progress ?? null, error: error instanceof Error ? error.message : String(error) });
    if (retrying && job.id) await dependencies.updateState(requestId, retryJobStatePatch(job.id));
    if (!retrying) {
      const failedState = await dependencies.getState(requestId);
      if (failedState?.typekeyPaths?.length) await dependencies.releasePaths(requestId, failedState.typekeyPaths);
      await dependencies.updateState(requestId, { typekeyPaths: undefined });
    }
    dependencies.error(retrying ? "typekey_attempt_failed" : "typekey_failed", { requestId, typekey: entry.typekey, attempt: job.attemptsMade + 1, willRetry: retrying, error: error instanceof Error ? error.message : String(error) });
    if (unrecoverable) throw dependencies.makeUnrecoverable(error instanceof Error ? `${error.name}: ${error.message}` : String(error), error);
    throw error;
  }
}
