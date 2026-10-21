import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createBmwContainer } from "../../src/composition/container.js";
import { loadConfig } from "../../src/config.js";
import type { LabourInput } from "../../src/domain/labour/types.js";

const container = createBmwContainer(loadConfig(process.env));
const { jobs, objectStorage, redis, config } = container;

beforeAll(async () => {
  await objectStorage.ensureBucket();
});

afterAll(async () => {
  await container.close();
});

async function cancelAndWait(requestId: string) {
  await jobs.cancelLabour(requestId);
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await jobs.state(requestId))?.status === "cancelled") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Cancellation cleanup did not finish for ${requestId}`);
}

describe("Redis and RustFS characterization", () => {
  test("stores and deletes an S3 object under the BMW typekey layout", async () => {
    const requestMarker = randomUUID();
    const key = objectStorage.objectKey("BMW", `INTEGRATION-${requestMarker}`, "labour", "7", "G70", "20261009", "11EH", "probe.json");
    const value = { marker: requestMarker, records: [1, 2, 3] };

    await objectStorage.putJson(key, value);
    expect(await objectStorage.getJson<typeof value>(key)).toEqual(value);
    expect(await objectStorage.deletePrefix(key.replace(/\/probe\.json$/, ""))).toBeGreaterThan(0);
    await expect(objectStorage.getJson<typeof value>(key)).rejects.toThrow();
  });

  test("enqueues a request, persists its state, indexes it, and cancels it", async () => {
    const requestId = randomUUID();
    const axCode = `INTEGRATION_${requestId.replaceAll("-", "")}`;
    const id = await jobs.enqueueLabour({
      manufacturer: "BMW",
      axCode,
      series: "7",
      date: "20261009",
      typekeys: [{ typekey: "11EH", family: "G70" }],
    }, 0, requestId);

    expect(id).toBe(requestId);
    expect(await jobs.state(requestId)).toMatchObject({ requestId, status: "queued", queueJobId: expect.any(String), typekeySummary: { date: "20261009" } });
    expect(await jobs.listLabours({ axCode })).toMatchObject({ items: [{ requestId, manufacturer: "BMW", axCode }], nextCursor: null });

    await cancelAndWait(requestId);
    expect(await jobs.state(requestId)).toMatchObject({ requestId, status: "cancelled" });
  });

  test("preserves the extraction queue options and execution-scoped job IDs", async () => {
    const requestId = randomUUID();
    await jobs.enqueueLabour({ manufacturer: "BMW", axCode: `QUEUE_${requestId.replaceAll("-", "")}`, series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] }, 0, requestId);
    const current = await jobs.state(requestId);
    const job = current?.queueJobId ? await jobs.labourQueue.getJob(current.queueJobId) : null;

    expect(current?.queueJobId).toMatch(new RegExp(`^${requestId}--[0-9a-f-]{36}--0$`));
    expect(job?.opts).toMatchObject({ attempts: 2, backoff: { type: "exponential", delay: 30000 }, removeOnComplete: true, removeOnFail: 100, ignoreDependencyOnFailure: true });
    await cancelAndWait(requestId);
  });

  test("resumes failed requests and paginates request lists without skipping entries", async () => {
    const axCode = `PAGINATION_${randomUUID().replaceAll("-", "")}`;
    const requestIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, requestId] of requestIds.entries()) {
      await jobs.enqueueLabour({ manufacturer: "BMW", axCode, series: "7", date: "20261009", typekeys: [{ typekey: `${11 + index}EH`, family: "G70" }] }, 0, requestId);
    }

    const first = await jobs.listLabours({ axCode }, undefined, 2);
    const second = await jobs.listLabours({ axCode }, first.nextCursor ?? undefined, 2);
    expect([...first.items, ...second.items].map(item => item.requestId)).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    expect(second.nextCursor).toBeNull();

    const resumeId = requestIds[0]!;
    const before = await jobs.state(resumeId);
    expect(before?.queueJobId).toBeTruthy();
    await (await jobs.labourQueue.getJob(before!.queueJobId!))?.remove();
    await redis.set(`bmw-reader:labour:${resumeId}`, JSON.stringify({ ...before, status: "failed", stage: "failed" }), "EX", config.STATE_TTL_SECONDS);
    await jobs.resumeLabour(resumeId);
    const after = await jobs.state(resumeId);
    expect(after).toMatchObject({ status: "queued", stage: "queued" });
    expect(after?.queueJobId).not.toBe(before?.queueJobId);

    for (const requestId of requestIds) await cancelAndWait(requestId);
  });

  test("releases the exact active typekey lock when cancelling a queued request", async () => {
    const requestId = randomUUID();
    const input: LabourInput = { manufacturer: "BMW", axCode: `LOCK_${requestId.replaceAll("-", "")}`, series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] };
    const id = await jobs.enqueueLabour(input, 0, requestId);
    const current = await jobs.state(id);
    const path = current?.typekeyPaths?.[0];
    expect(path).toBeTruthy();
    const lockHash = createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex");
    const lockKey = `bmw-reader:typekey-lock:${lockHash}`;
    expect(await redis.exists(lockKey)).toBe(1);

    await cancelAndWait(id);

    expect({ lock: await redis.get(lockKey), ownerHashes: await redis.smembers(`bmw-reader:typekey-lock-owners:${id}`) }).toEqual({ lock: null, ownerHashes: [] });
  });

  test("removes incomplete unshared typekey objects when cancelling", async () => {
    const requestId = randomUUID();
    const input: LabourInput = { manufacturer: "BMW", axCode: `CLEAN_${requestId.replaceAll("-", "")}`, series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] };
    const id = await jobs.enqueueLabour(input, 0, requestId);
    const current = await jobs.state(id);
    const path = current?.typekeyPaths?.[0];
    expect(path).toBeTruthy();
    const objectPath = objectStorage.objectKey(...path!.split("/"), "11EH_catalog.json");
    await objectStorage.putJson(objectPath, { incomplete: true });

    await cancelAndWait(id);

    expect(await objectStorage.getJsonIfExists(objectPath)).toBeUndefined();
  });

});
