import { createLabourWorker, createModelWorker } from "./jobs.js";
import { ensureBucket } from "./storage.js";

await ensureBucket();
const labourWorker = createLabourWorker();
const modelWorker = createModelWorker();
labourWorker.on("completed", job => console.log(JSON.stringify({ event: "labour_completed", requestId: job.data.requestId })));
labourWorker.on("failed", (job, error) => console.error(JSON.stringify({ event: "labour_failed", requestId: job?.data.requestId, error: error.message })));
labourWorker.on("error", error => console.error(JSON.stringify({ event: "labour_worker_error", error: error.message })));
modelWorker.on("completed", job => console.log(JSON.stringify({ event: "model_completed", requestId: job.data.requestId })));
modelWorker.on("failed", (job, error) => console.error(JSON.stringify({ event: "model_failed", requestId: job?.data.requestId, error: error.message })));
modelWorker.on("error", error => console.error(JSON.stringify({ event: "model_worker_error", error: error.message })));
