import { createExtractionWorker } from "./jobs.js";
import { ensureBucket } from "./storage.js";

await ensureBucket();
const worker = createExtractionWorker();
worker.on("completed", job => console.log(JSON.stringify({ event: "job_completed", requestId: job.data.requestId })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "job_failed", requestId: job?.data.requestId, error: error.message })));
worker.on("error", error => console.error(JSON.stringify({ event: "worker_error", error: error.message })));
