import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { enqueueLabour, extractionQueue, listLabours, state, cancelLabour, retryJobStatePatch, type LabourInput } from "../../src/jobs.js";
import { deletePrefix, ensureBucket, getJson, getJsonIfExists, objectKey, putJson } from "../../src/storage.js";
import { redis } from "../../src/redis.js";
import { config } from "../../src/config.js";

beforeAll(async () => {
  await ensureBucket();
});

afterAll(async () => {
  await extractionQueue.close();
});

describe("Redis and RustFS characterization", () => {
  test("stores and deletes an S3 object under the BMW typekey layout", async () => {
    const requestMarker = randomUUID();
    const key = objectKey("BMW", `INTEGRATION-${requestMarker}`, "labour", "7", "G70", "20261009", "11EH", "probe.json");
    const value = { marker: requestMarker, records: [1, 2, 3] };

    await putJson(key, value);
    expect(await getJson<typeof value>(key)).toEqual(value);
    expect(await deletePrefix(key.replace(/\/probe\.json$/, ""))).toBeGreaterThan(0);
    await expect(getJson<typeof value>(key)).rejects.toThrow();
  });

  test("enqueues a request, persists its state, indexes it, and cancels it", async () => {
    const requestId = randomUUID();
    const manufacturer = `INTEGRATION-${requestId}`;
    const id = await enqueueLabour({
      manufacturer,
      series: "7",
      date: "20261009",
      typekeys: [{ typekey: "11EH", family: "G70" }],
    }, 0, requestId);

    expect(id).toBe(requestId);
    expect(await state(requestId)).toMatchObject({ requestId, status: "queued", resource: "labours" });
    expect(await listLabours({ manufacturer })).toMatchObject({ items: [{ requestId, manufacturer }], nextCursor: null });

    expect(await cancelLabour(requestId)).toMatchObject({ requestId, status: "cancelled" });
    expect(await state(requestId)).toMatchObject({ requestId, status: "cancelled" });
  });

  test("releases the exact active typekey lock when cancelling a queued request", async () => {
    const requestId = randomUUID();
    const input: LabourInput = { manufacturer: `LOCK-${requestId}`, series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] };
    const id = await enqueueLabour(input, 0, requestId);
    const current = await state(id);
    const path = current?.typekeyPaths?.[0];
    expect(path).toBeTruthy();
    const lockHash = createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex");
    const lockKey = `bmw-reader:active-typekey:${lockHash}`;
    expect(await redis.exists(lockKey)).toBe(1);

    await cancelLabour(id);

    expect({ lock: await redis.get(lockKey), ownerHashes: await redis.smembers(`bmw-reader:active-typekey-owners:${id}`) }).toEqual({ lock: null, ownerHashes: [] });
  });

  test("removes incomplete unshared typekey objects when cancelling", async () => {
    const requestId = randomUUID();
    const input: LabourInput = { manufacturer: `CLEAN-${requestId}`, series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] };
    const id = await enqueueLabour(input, 0, requestId);
    const current = await state(id);
    const path = current?.typekeyPaths?.[0];
    expect(path).toBeTruthy();
    const objectPath = objectKey(...path!.split("/"), "11EH_catalog.json");
    await putJson(objectPath, { incomplete: true });

    await cancelLabour(id);

    expect(await getJsonIfExists(objectPath)).toBeUndefined();
  });

});
