import { randomUUID } from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import { resolveModelSeries } from "../domain/labour/series.js";
import { baseExtractionDate } from "../domain/labour/validation.js";
import type { TypekeyExtractionInput, LabourState } from "../domain/labour/labour-state.js";
import type { LabourInput } from "../domain/labour/types.js";
import type { TypekeyLocks } from "../application/ports/typekey-locks.js";
import { withCachedCatalog } from "../application/bmw/cached-catalog-client.js";
import type { CatalogCache } from "../application/ports/catalog-cache.js";
import type { LabourQueue } from "../application/ports/labour-queue.js";
import type { Logger } from "@solera/core-reader/application/ports/runtime";
import { BmwRequestCancelledError, type BmwClient } from "../infrastructure/bmw/client.js";
import type { BmwClientOverrides } from "../infrastructure/bmw/client.js";
import type { FetchTypekeyRequest } from "../application/use-cases/fetch-typekey.js";
import { processLabourTypekeyUseCase, type TypekeyDownloadResult } from "../application/use-cases/process-labour-typekey.js";
import { typekeyPathForJob } from "../application/typekey-path.js";

type ProcessorDependencies = {
  redis: Redis;
  config: AppConfig;
  createBmwClient(overrides?: BmwClientOverrides): BmwClient;
  catalogCache: CatalogCache;
  fetchTypekey(request: Omit<FetchTypekeyRequest, "services">): Promise<TypekeyDownloadResult>;
  state(requestId: string): Promise<LabourState | null>;
  updateState(requestId: string, patch: Partial<LabourState>, ifMatches?: Partial<LabourState>): Promise<LabourState | null>;
  finishLabour(requestId: string, input: LabourInput, summaries: NonNullable<LabourState["typekeySummary"]>["typekeys"]): Promise<unknown>;
  finalizeCancelledJob(requestId: string, current: LabourState): Promise<unknown>;
  typekeyLocks: Pick<TypekeyLocks, "renew" | "release">;
  releaseCompletedTypekeyPath(requestId: string, input: LabourInput, typekey: string): Promise<void>;
  cancellationFlags: { isRequested(requestId: string): Promise<boolean> };
  activeCancellation: Map<string, AbortController>;
  isWorkerShuttingDown(): boolean;
  addPaused(requestId: string): Promise<void>;
  queue: Pick<LabourQueue, "enqueue">;
  logger: Logger;
};

export function createLabourTypekeyProcessor(dependencies: ProcessorDependencies) {
  const { redis, config, createBmwClient, catalogCache, fetchTypekey, state, updateState, finishLabour, finalizeCancelledJob, typekeyLocks, cancellationFlags, activeCancellation, isWorkerShuttingDown, addPaused, queue, logger } = dependencies;

  return async function processLabourTypekey(job: Job) {
    const { requestId, input, index, runId: jobRunId } = job.data as { requestId: string; input: LabourInput; index: number; runId?: string };
    const replacementAttempt = Boolean(job.data.replacementAttempt);
    const runId = jobRunId ?? randomUUID();
    const controller = new AbortController();
    const heartbeatKey = `bmw-reader:labour:${requestId}:heartbeat`;
    const heartbeatTimer = setInterval(() => {
      void redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
      void typekeyLocks.renew(requestId).catch(error => logger.warn("typekey_lock_renew_failed", { requestId, error: error instanceof Error ? error.message : String(error) }));
      void cancellationFlags.isRequested(requestId).then(requested => { if (requested) controller.abort(); }).catch(error => logger.warn("cancel_flag_poll_failed", { requestId, error: error instanceof Error ? error.message : String(error) }));
    }, 5000);
    heartbeatTimer.unref?.();
    await redis.set(heartbeatKey, JSON.stringify({ runId }), "PX", 30000);
    activeCancellation.set(requestId, controller);
    try {
      if (await cancellationFlags.isRequested(requestId)) controller.abort();
      return await processLabourTypekeyUseCase({ attemptsMade: job.attemptsMade, attempts: Number(job.opts.attempts ?? 1), id: job.id ? String(job.id) : undefined }, requestId, input, index, runId, replacementAttempt, {
        async download(labour, labourIndex, id, _runId, forceRestart, onProgress) {
          const entry = labour.typekeys[labourIndex]!;
          const series = resolveModelSeries(entry.series, labour.series);
          const typekeyInput: TypekeyExtractionInput = { manufacturer: labour.manufacturer, series, model: entry.model ?? labour.model ?? "", family: entry.family, axCode: labour.axCode, edition: labour.edition ?? labour.date, language: labour.language };
          const client = createBmwClient({ language: labour.language ?? config.BMW_API_LANGUAGE, onRateLimitChange: async event => {
            if (event.recovered) {
              const current = await state(id);
              if (current && (current.status === "running" || current.status === "rate_limited")) {
                await updateState(id, { ...(current.status === "rate_limited" ? { status: "running", stage: `${entry.typekey}:resumed` } : {}), rateLimitInfo: undefined }, { status: current.status });
              }
              return;
            }
            const retryAt = new Date(Date.now() + event.cooldownMs).toISOString();
            const current = await state(id);
            if (current && (current.status === "running" || current.status === "rate_limited")) {
              await updateState(id, { rateLimitInfo: { count: event.count, cooldownUntil: retryAt, retryAfterMs: event.retryAfterMs }, ...(event.cooldownMs > 10000 ? { status: "rate_limited", stage: `${entry.typekey}:rate-limited` } : {}) }, { status: current.status });
            }
          }, cancelSignal: controller.signal });
          await updateState(id, { status: "running", stage: `${entry.typekey}:preparing` });
          logger.info("typekey_started", { requestId: id, typekey: entry.typekey, index: labourIndex });
          const cachedClient = withCachedCatalog(client, catalogCache, labour.language ?? config.BMW_API_LANGUAGE);
          return fetchTypekey({ client: cachedClient, input: typekeyInput, typekey: entry.typekey, requestId: id, date: baseExtractionDate(labour.date), onProgress, resume: true, shouldStop: () => isWorkerShuttingDown() || controller.signal.aborted, forceRestart });
        },
        state: { get: state, update: updateState, finish: finishLabour },
        cancellation: {
          finalize: finalizeCancelledJob,
          isRequested: async id => cancellationFlags.isRequested(id) || controller.signal.aborted,
          isCancelledError: error => error instanceof BmwRequestCancelledError,
        },
        worker: { isShuttingDown: isWorkerShuttingDown, addPaused, now: Date.now },
        typekeyLocks: { releaseCompletedPath: dependencies.releaseCompletedTypekeyPath, releasePaths: typekeyLocks.release },
        queue: { next: async (_id, labour, nextIndex, activeRunId, nextJobId) => {
          const typekeyPaths = labour.typekeys.map((_entry, typekeyIndex) => typekeyPathForJob(labour, typekeyIndex)).filter((path): path is string => Boolean(path));
          await queue.enqueue({ requestId, input: labour, index: nextIndex, runId: activeRunId, typekeyPaths }, nextJobId);
        } },
        logger,
        makeUnrecoverable: (message, cause) => {
          const error = new UnrecoverableError(message);
          if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true });
          return error;
        },
      });
    } finally {
      clearInterval(heartbeatTimer);
      if (activeCancellation.get(requestId) === controller) activeCancellation.delete(requestId);
      const heartbeat = await redis.get(heartbeatKey);
      if (heartbeat && JSON.parse(heartbeat).runId === runId) await redis.del(heartbeatKey);
    }
  };
}
