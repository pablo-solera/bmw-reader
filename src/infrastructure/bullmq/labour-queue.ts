import type { Redis } from "ioredis";
import { createBullMqQueue, type BullMqQueueClient } from "@solera/core-reader/infrastructure/bullmq/adapter";
import type { LabourQueue } from "../../application/ports/labour-queue.js";
import { LABOUR_JOB_OPTIONS, LABOUR_QUEUE_NAME, toLabourQueueState } from "./labour-queue-policy.js";

export function createBullMqLabourQueue(redis: Redis) {
  let queuePromise: Promise<BullMqQueueClient<Record<string, unknown>, unknown>> | undefined;
  const getQueue = () => queuePromise ??= createBullMqQueue<Record<string, unknown>, unknown>(LABOUR_QUEUE_NAME, { connection: redis });
  const client = {
    add: async (...args: Parameters<BullMqQueueClient<Record<string, unknown>, unknown>["add"]>) => (await getQueue()).add(...args),
    getJob: async (...args: Parameters<BullMqQueueClient<Record<string, unknown>, unknown>["getJob"]>) => (await getQueue()).getJob(...args),
    getJobCounts: async (...args: string[]) => (await getQueue()).getJobCounts(...args),
    close: async () => { if (queuePromise) await (await queuePromise).close(); },
  };
  const port: LabourQueue = {
    enqueue: async (data, jobId) => {
      const job = await client.add("typekey", data, { ...LABOUR_JOB_OPTIONS, jobId });
      return { id: String(job.id ?? jobId) };
    },
    getJob: async id => {
      const job = await client.getJob(id);
      return job ? { id: String(job.id), getState: async () => toLabourQueueState(await job.getState()), remove: () => job.remove() } : null;
    },
  };
  return { client, port };
}
