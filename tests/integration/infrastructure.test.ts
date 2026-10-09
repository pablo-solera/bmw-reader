import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { enqueueLabour, listLabours, state, cancelLabour } from "../../src/jobs.js";
import { deletePrefix, ensureBucket, getJson, objectKey, putJson } from "../../src/storage.js";
import { extractionQueue } from "../../src/jobs.js";

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
});
