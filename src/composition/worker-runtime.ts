import type { Redis } from "ioredis";
import type { createBmwObjectStorage } from "../storage.js";
import { acquireWorkerLock, clearWorkerHeartbeat, releaseWorkerLock, renewWorkerLock, workerHeartbeatKey } from "../worker-lock.js";
import type { JobsRuntime } from "./jobs-runtime.js";
import { completedJobEvent, failedJobEvent } from "../application/worker-events.js";
import { EXTRACTION_QUEUE_NAME } from "../application/ports/extraction-queue-policy.js";

export type WorkerContainer = {
  redis: Redis;
  objectStorage: ReturnType<typeof createBmwObjectStorage>;
  jobs: JobsRuntime;
};

export async function createWorkerRuntime(container: WorkerContainer) {
  await container.objectStorage.ensureBucket();
  const lockToken = crypto.randomUUID();
  if (!await acquireWorkerLock(container.redis, lockToken)) throw new Error("A bmw-reader worker is already active; refusing to start a duplicate worker");
  await container.redis.set(workerHeartbeatKey, String(Date.now()), "PX", 30000);
  const heartbeat = setInterval(() => {
    void renewWorkerLock(container.redis, lockToken).then(alive => {
      if (!alive) {
        console.error(JSON.stringify({ event: "worker_singleton_lock_lost" }));
        void shutdown("LOCK_LOST");
      }
    }).catch(error => console.error(JSON.stringify({ event: "worker_heartbeat_failed", error: error instanceof Error ? error.message : String(error) })));
  }, 10000);
  heartbeat.unref();

  const worker = await container.jobs.createExtractionWorker();
  await container.jobs.ensureLabourIndex();
  await container.jobs.recoverCancelledLabours();
  await container.jobs.resumePausedJobs();
  worker.on("ready", () => console.log(JSON.stringify({ event: "worker_ready", queue: EXTRACTION_QUEUE_NAME })));
  worker.on("completed", (job, result) => console.info(JSON.stringify(completedJobEvent(job.data.requestId, job.data.input?.typekeys?.[Number(job.data.index)]?.typekey, result))));
  worker.on("failed", (job, error) => {
    if (!job) return;
    console.error(JSON.stringify(failedJobEvent(job, error)));
  });
  worker.on("stalled", jobId => console.warn(JSON.stringify({ event: "extraction_stalled_recovered", jobId })));
  worker.on("error", error => console.error(JSON.stringify({ event: "worker_error", error: error.message })));

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    container.jobs.setWorkerShuttingDown(true);
    console.info(JSON.stringify({ event: "worker_shutdown_started", signal }));
    const closed = worker.close(false);
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let forced = false;
    try { await Promise.race([closed, new Promise<void>(resolve => { shutdownTimer = setTimeout(() => { forced = true; resolve(); }, 75000); })]); }
    catch (error) { console.error(JSON.stringify({ event: "worker_close_failed", signal, error: error instanceof Error ? error.message : String(error) })); forced = true; }
    if (shutdownTimer) clearTimeout(shutdownTimer);
    clearInterval(heartbeat);
    if (forced) {
      console.warn(JSON.stringify({ event: "worker_shutdown_forced", signal, detail: "Leaving singleton lease to expire for BullMQ recovery" }));
      try { await clearWorkerHeartbeat(container.redis, lockToken); }
      catch (error) { console.error(JSON.stringify({ event: "worker_heartbeat_clear_failed", error: error instanceof Error ? error.message : String(error) })); }
      void container.redis.quit();
      process.exit(signal === "LOCK_LOST" ? 1 : 0);
    }
    try { await clearWorkerHeartbeat(container.redis, lockToken); }
    catch (error) { console.error(JSON.stringify({ event: "worker_heartbeat_clear_failed", error: error instanceof Error ? error.message : String(error) })); }
    await releaseWorkerLock(container.redis, lockToken);
    await container.redis.quit();
    console.info(JSON.stringify({ event: "worker_shutdown_complete", signal }));
    process.exit(signal === "LOCK_LOST" ? 1 : 0);
  }
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("beforeExit", () => { void shutdown("BEFORE_EXIT"); });
  return { worker, shutdown };
}
