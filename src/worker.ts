import { createExtractionWorker, migrateLegacyQueueJobs, resumePausedJobs, setWorkerShuttingDown } from "./jobs.js";
import { ensureBucket } from "./storage.js";
import { redis } from "./redis.js";
import { acquireWorkerLock, releaseWorkerLock, renewWorkerLock } from "./worker-lock.js";

await ensureBucket();
const lockToken = crypto.randomUUID();
if (!await acquireWorkerLock(redis, lockToken)) throw new Error("A bmw-reader worker is already active; refusing to start a duplicate worker");
await redis.set("bmw-reader:worker:heartbeat", String(Date.now()), "PX", 30000);
const heartbeat = setInterval(() => {
  void renewWorkerLock(redis, lockToken).then(alive => {
    if (!alive) {
      console.error(JSON.stringify({ event: "worker_singleton_lock_lost" }));
      void shutdown("LOCK_LOST");
    }
  }).catch(error => console.error(JSON.stringify({ event: "worker_heartbeat_failed", error: error instanceof Error ? error.message : String(error) })));
}, 10000);
heartbeat.unref();

const worker = createExtractionWorker();
await migrateLegacyQueueJobs();
await resumePausedJobs();
worker.on("ready", () => console.log(JSON.stringify({ event: "worker_ready", queue: "bmw-extractions" })));
worker.on("completed", job => console.log(JSON.stringify({ event: "extraction_completed", requestId: job.data.requestId })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "extraction_failed", requestId: job?.data.requestId, error: error.message })));
worker.on("stalled", jobId => console.warn(JSON.stringify({ event: "extraction_stalled_recovered", jobId })));
worker.on("error", error => console.error(JSON.stringify({ event: "worker_error", error: error.message })));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  setWorkerShuttingDown(true);
  console.info(JSON.stringify({ event: "worker_shutdown_started", signal }));
  await worker.close(true);
  clearInterval(heartbeat);
  await releaseWorkerLock(redis, lockToken);
  await redis.quit();
  console.info(JSON.stringify({ event: "worker_shutdown_complete", signal }));
  process.exit(signal === "LOCK_LOST" ? 1 : 0);
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("beforeExit", () => { void shutdown("BEFORE_EXIT"); });
