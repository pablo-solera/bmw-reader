import { describe, expect, test } from "bun:test";
import { catalogItems, findAwSheetGroups, flatrateGroups } from "../src/application/bmw/parse.js";
import { fetchAwSheetDetails, isUpstreamOutage } from "../src/application/use-cases/fetch-typekey.js";
import { mapConcurrent } from "reader-core/shared/concurrency";
import { normalizeTypeResearchResponse } from "../src/infrastructure/bmw/type-research.js";
import { acquireWorkerLock, releaseWorkerLock, renewWorkerLock } from "../src/infrastructure/redis/worker-lock.js";
import { AccessTokenPool, nextTokenIndex, tokenExpiresAt } from "../src/infrastructure/bmw/auth.js";
import { BmwRequestCancelledError, sleepUntil, transientRetryDelay } from "../src/infrastructure/bmw/client.js";
import { cancellationDecision } from "../src/domain/labour/policies.js";
import { summarizeLabourList } from "../src/application/use-cases/list-labours.js";
import { incompleteTypekeysForCleanup, typekeyPathForJob, relativeTypekeyPath } from "../src/application/typekey-path.js";
import { parseLabourCursor as listCursorOffset, labourNextCursor as listNextCursor } from "../src/domain/labour/cursor.js";
import { createLabourTypekeyJobId as extractionJobId } from "../src/domain/labour/labour-job-id.js";
import { completedJobEvent, failedJobEvent } from "../src/application/worker-events.js";
import { createRedisTypekeyLocks, type TypekeyLockRedis } from "../src/infrastructure/redis/typekey-locks.js";
import { RedisTypekeyProgressStore, type TypekeyProgressRedis } from "../src/infrastructure/redis/typekey-progress-store.js";
import { addCompletedRequest } from "../src/domain/labour/typekey-completion.js";
import { createBmwObjectStorage } from "../src/infrastructure/s3/object-storage.js";
import { loadConfig } from "../src/config.js";
import { normalizeModelSeries, resolveModelSeries } from "../src/domain/labour/series.js";
import { S3Store, type S3Adapter } from "reader-core/infrastructure/s3/object-storage";
import { RedisStateStore } from "reader-core/infrastructure/redis/state-store";
import { exponentialRetryDelay, retryAfterMilliseconds } from "reader-core/shared/retry";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import { UnrecoverableError } from "bullmq";

describe("BMW extraction helpers", () => {
  test("recognizes consecutive upstream failures", async () => {
    expect(isUpstreamOutage([true, false, false])).toBe(false);
    expect(isUpstreamOutage([true, false, false, false])).toBe(true);
  });
  test("bounds transient 5xx retries by time and honors Retry-After", () => {
    expect(transientRetryDelay(0, 0, 600000, 0, 100)).toBe(1100);
    expect(transientRetryDelay(5000, 1, 600000, 12000, 100)).toBe(12000);
    expect(transientRetryDelay(599000, 6, 600000, 0, 1000)).toBe(1000);
    expect(transientRetryDelay(600000, 6, 600000)).toBeNull();
  });
  test("shared retry policy supports Retry-After seconds and HTTP date formats", () => {
    expect(retryAfterMilliseconds("2", 0)).toBe(2000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
    expect(exponentialRetryDelay(500, 1, 10000, 0, 0)).toBe(2000);
  });
  test("keyspace and bounded concurrency are reusable helpers", async () => {
    const key = createKeyspace("bmw-reader:");
    expect(key(":job:", "id")).toBe("bmw-reader:job:id");
    let active = 0;
    let maximum = 0;
    await mapConcurrent([1, 2, 3, 4], 2, async value => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return value;
    });
    expect(maximum).toBe(2);
  });
  test("interrupts retry backoff when the cancellation signal aborts", async () => {
    const controller = new AbortController();
    const pending = sleepUntil(10000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BmwRequestCancelledError);
  });
  test("uses unique execution-scoped IDs when resuming a typekey job", () => {
    expect(extractionJobId("request", "run-one", 0)).not.toBe(extractionJobId("request", "run-two", 0));
    expect(extractionJobId("request", "run-one", 0)).toBe("request--run-one--0");
  });
  test("labels the BullMQ completed event separately from full extraction completion", () => {
    expect(completedJobEvent("request", "21EJ", { kind: "typekey" })).toEqual({ event: "extraction_job_completed", requestId: "request", typekey: "21EJ", result: { kind: "typekey" } });
  });
  test("marks BullMQ unrecoverable failures as final in worker logs", () => {
    const job = { data: { requestId: "request", index: 0, input: { typekeys: [{ typekey: "21EJ" }] } }, attemptsMade: 1, opts: { attempts: 2 } };
    expect(failedJobEvent(job, new UnrecoverableError("permanent"), error => error instanceof UnrecoverableError)).toMatchObject({ event: "extraction_failed", requestId: "request", typekey: "21EJ", willRetry: false });
    expect(failedJobEvent(job, new Error("temporary"), error => error instanceof UnrecoverableError)).toMatchObject({ event: "extraction_attempt_failed", willRetry: true });
  });
  test("releases the single-hash typekey lock instead of hashing the hash again", async () => {
    const calls: Array<{ script: string; args: Array<string | number> }> = [];
    const fakeRedis = {
      async eval(script: string, _keyCount: number, ...args: Array<string | number>) { calls.push({ script, args }); return 1; },
      async smembers() { return []; },
    };
    const locks = createRedisTypekeyLocks(fakeRedis as unknown as TypekeyLockRedis, "bucket", 3600);
    await locks.release("request", ["BMW/BMW/labour/7/G70/20261009/11EH"]);
    expect(calls[0]?.args[0]).toBe(`bmw-reader:typekey-lock:${locks.hashPath("BMW/BMW/labour/7/G70/20261009/11EH")}`);
  });
  test("can claim paths when the port method is destructured and rolls back partial claims", async () => {
    const calls: Array<{ script: string; keyCount: number; args: Array<string | number> }> = [];
    const fakeRedis = {
      async eval(script: string, keyCount: number, ...args: Array<string | number>) {
        calls.push({ script, keyCount, args });
        return [0, "another-request:owner"];
      },
      async smembers() { return []; },
    };
    const locks = createRedisTypekeyLocks(fakeRedis as unknown as TypekeyLockRedis, "bucket", 3600);
    const { claim } = locks;
    await expect(claim("request", {
      manufacturer: "BMW", series: "7", date: "20260928",
      typekeys: [{ typekey: "11HC", family: "G26" }, { typekey: "21HC", family: "G26" }],
    })).rejects.toThrow("Extraction already has a queued or active job");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.keyCount).toBe(3);
    expect(calls[0]?.script).toContain("for j = 1, i - 1 do if created[j] then redis.call('DEL', KEYS[j]) end end");
  });
  test("cancellation is final for completed jobs and repeat calls are idempotent", () => {
    expect(cancellationDecision(undefined)).toBe("not-found");
    expect(cancellationDecision("completed")).toBe("conflict");
    expect(cancellationDecision("cancelling")).toBe("already-cancelled");
    expect(cancellationDecision("cancelled")).toBe("already-cancelled");
    expect(cancellationDecision("running")).toBe("cancel");
  });
  test("cancellation cleanup targets every incomplete path", () => {
    const input = { manufacturer: "BMW", series: "4'", date: "20260928", typekeys: [{ typekey: "11HC", series: "4'", family: "G26" }, { typekey: "21HC", series: "4'", family: "G26" }, { typekey: "23FB", series: "4'", family: "G26" }] };
    const completed = new Set(["BMW/BMW/labour/4/G26/20260928/11HC"]);
    expect(incompleteTypekeysForCleanup(input, completed).map(item => item.entry.typekey)).toEqual(["21HC", "23FB"]);
  });
  test("cancellation cleanup path uses the exact typekey series/family/date", () => {
    const input = { manufacturer: "BMW", series: "4'", date: "20260928", typekeys: [{ typekey: "11HC", series: "4'", family: "G26" }] };
    expect(typekeyPathForJob(input, 0)).toBe("BMW/BMW/labour/4/G26/20260928/11HC");
  });
  test("typekey completion requests are deduplicated by request ID", () => {
    const marker = { schemaVersion: 1 as const, path: "BMW/BMW/labour/7/G/20260928/21EJ", group: "BMW", manufacturer: "BMW", series: "7", model: "X", family: "G", typekey: "21EJ", date: "20260928", hgs: 1, awSheetOIDs: 1, inklusivPositionenFiles: 1, umfasstTexteFiles: 0, startedAt: "start", completedAt: "done", durationMs: 10, language: "en-GB", requestId: "request-1", axCode: "A", edition: "20260928", requests: [] };
    const first = addCompletedRequest(marker, { requestId: "request-1", axCode: "A", edition: "20260928", at: "done", reused: false });
    const duplicate = addCompletedRequest(first, { requestId: "request-1", axCode: "A", edition: "20260928", at: "later", reused: true });
    const second = addCompletedRequest(duplicate, { requestId: "request-2", axCode: "B", edition: "20261001", at: "later", reused: true });
    expect(second.requests).toHaveLength(2);
    expect(second.requests[1]?.reused).toBe(true);
  });
  test("stores, resumes, de-duplicates and clears OID progress in Redis", async () => {
    const sets = new Map<string, Set<string>>();
    const hashes = new Map<string, Map<string, string>>();
    const fake = {
      async eval(script: string, _keyCount: number, completedKey: string, failedKey: string, metaKey: string, ...args: Array<string | number>) {
        const completed = sets.get(String(completedKey)) ?? new Set<string>(); sets.set(String(completedKey), completed);
        const meta = hashes.get(String(metaKey)) ?? new Map<string, string>(); hashes.set(String(metaKey), meta);
        if (script.includes("SADD")) {
          const [oid, inclusive, surrounding] = args;
          const inserted = !completed.has(String(oid)); completed.add(String(oid));
          hashes.get(String(failedKey))?.delete(String(oid));
          if (inserted) { meta.set("inklusivPositionenFiles", String(Number(meta.get("inklusivPositionenFiles") ?? 0) + Number(inclusive))); meta.set("umfasstTexteFiles", String(Number(meta.get("umfasstTexteFiles") ?? 0) + Number(surrounding))); }
          return inserted ? 1 : 0;
        }
        if (script.includes("HSETNX")) {
          const [startedAt, pathValue, requestId, axCode, edition, language] = args;
          meta.set("startedAt", String(startedAt)); meta.set("path", String(pathValue)); meta.set("requestId", String(requestId));
          meta.set("axCode", String(axCode)); meta.set("edition", String(edition)); meta.set("language", String(language));
          meta.set("inklusivPositionenFiles", "0"); meta.set("umfasstTexteFiles", "0");
        }
        if (script.includes("'cancelledByRequestId', ARGV[1]")) { meta.set("requestId", String(args[0])); meta.set("cancelledByRequestId", String(args[0])); meta.set("cancellationMessage", String(args[1])); }
        if (script.includes("HGETALL', KEYS[3]")) return [...meta].flatMap(([key, value]) => [key, value]);
        if (script.includes("SMEMBERS', KEYS[1]")) return [...completed];
        if (script.includes("'HGET', KEYS[3], 'cancelledByRequestId'")) return [meta.get("cancelledByRequestId") ?? "", meta.get("cancellationMessage") ?? ""];
        if (script.includes("HGETALL', KEYS[2]")) return [...(hashes.get(String(failedKey)) ?? [])].flatMap(([key, value]) => [key, value]);
        return 1;
      },
      async del(...keys: string[]) { for (const key of keys) { sets.delete(key); hashes.delete(key); } return keys.length; },
    };
    const store = new RedisTypekeyProgressStore(fake as unknown as TypekeyProgressRedis, 3600, "test-bucket", "en-GB");
    const path = "BMW/BMW/labour/7/G70/20260928/21EJ";
    await store.initialize(path, { requestId: "req-1", axCode: "A", edition: "20260928", language: "en-GB" });
    await store.recordFailed(path, "oid-1", "502");
    expect(await store.recordCompleted(path, "oid-1", 2, 1)).toBe(true);
    expect(await store.recordCompleted(path, "oid-1", 2, 1)).toBe(false);
    expect(await store.completed(path)).toEqual(["oid-1"]);
    expect(await store.failures(path)).toEqual({});
    expect(await store.metadata(path)).toMatchObject({ inklusivPositionenFiles: 2, umfasstTexteFiles: 1 });
    await store.clear(path);
    expect(await store.completed(path)).toEqual([]);
  });
  test("validates deletions as a single typekey prefix with optional S3 prefix", () => {
    const storage = createBmwObjectStorage(loadConfig({}));
    const valid = storage.objectKey("BMW", "BMW", "labour", "7", "G70", "20260928", "21EJ");
    expect(storage.isTypekeyPrefix(valid)).toBe(true);
    expect(storage.isTypekeyPrefix(storage.objectKey("BMW", "BMW", "labour", "7", "G70", "2026", "21EJ"))).toBe(false);
    expect(storage.isTypekeyPrefix("BMW/BMW/labour")).toBe(false);
    expect(storage.objectKey("BMW", "BMW", "labour").endsWith("BMW/BMW/labour")).toBe(true);
  });
  test("normalizes series for typekey S3 paths, not descriptive model names", () => {
    expect(normalizeModelSeries("7'")).toBe("7");
    expect(resolveModelSeries(undefined, "7'")).toBe("7");
    expect(resolveModelSeries("X'", "7'")).toBe("X");
    expect(relativeTypekeyPath("BMW", "BMW", "X'", "G05", "20260928", "UD42")).toBe("BMW/BMW/labour/X/G05/20260928/UD42");
    expect(() => normalizeModelSeries("../bucket")).toThrow();
  });
  test("filters and orders the labour request list and returns empty for no matches", () => {
    const base = {
      status: "completed" as const, stage: "completed", progress: 100, resource: "labours" as const,
      typekeySummary: { date: "20260928", axCode: "11I", typekeys: [{ typekey: "11HC", series: "4", family: "G26", model: "430i", hgs: 10, awSheetOIDs: 50, completedAwSheetOIDs: 50, remainingAwSheetOIDs: 0 }] },
      input: { manufacturer: "BMW", model: "430i", series: "4", family: "G26", axCode: "11I", edition: "05_0", date: "20260928", typekeys: ["11HC"] },
      createdAt: "2026-09-28T10:00:00.000Z", updatedAt: "2026-09-28T10:05:00.000Z", requestId: "older",
    };
    const newer = { ...base, requestId: "newer", status: "failed" as const, createdAt: "2026-09-29T10:00:00.000Z", error: "failed" };
    const all = summarizeLabourList([base, newer]);
    expect(all.map(item => item.requestId)).toEqual(["newer", "older"]);
    expect(summarizeLabourList([base, newer], { axCode: "11I", edition: "05_0", status: ["completed"] })).toHaveLength(1);
    expect(all[1]).toMatchObject({ manufacturer: "BMW", typekeys: [{ typekey: "11HC" }], axCode: "11I", edition: "05_0" });
  });
  test("validates keyset cursor tokens and rejects the old offset format", () => {
    expect(listCursorOffset(listNextCursor({ score: 150, requestId: "job-1" }))).toEqual({ score: 150, requestId: "job-1" });
    expect(() => listCursorOffset(Buffer.from("v1:150").toString("base64url"))).toThrow("cursor is invalid");
    expect(() => listCursorOffset("not-base64-cursor")).toThrow("cursor is invalid");
  });
  test("distinguishes missing states from empty Redis values when pruning the index", () => {
    const one = summarizeLabourList([null]);
    expect(one).toEqual([]);
  });
  test("rotates through token-pool slots and renews only the rejected token", async () => {
    let serial = 0;
    const pool = new AccessTokenPool(3, async () => ({ access_token: `token-${++serial}`, expires_in: 3600 }), 0);
    expect(await pool.get()).toBe("token-1");
    expect(await pool.get()).toBe("token-2");
    expect(await pool.get()).toBe("token-3");
    expect(await pool.get()).toBe("token-1");
    expect(await pool.renew("token-2")).toBe("token-4");
    expect(await pool.get()).toBe("token-4");
    expect(await pool.get()).toBe("token-3");
    expect(nextTokenIndex(9, 10)).toBe(0);
    expect(tokenExpiresAt(1000, 3600)).toBe(3541000);
  });
  test("mapConcurrent waits for in-flight work and does not schedule after first rejection", async () => {
    const visited: number[] = [];
    await expect(mapConcurrent([0, 1, 2, 3, 4], 2, async value => {
      visited.push(value);
      if (value === 1) throw new Error("429");
      await new Promise(resolve => setTimeout(resolve, 5));
      return value;
    })).rejects.toThrow("429");
    expect(visited).toEqual([0, 1]);
  });
  test("worker singleton lock rejects duplicates, renews and releases only its owner", async () => {
    let owner: string | null = null;
    const fakeRedis = {
      async eval(script: string, _keyCount: number, ...args: Array<string | number>) {
        if (script.includes("'NX'")) { if (owner) return 0; owner = String(args[1]); return 1; }
        if (script.includes("PEXPIRE")) return owner === args[_keyCount === 1 ? 1 : 2] ? 1 : 0;
        if (owner === args[1]) { owner = null; return 1; }
        return 0;
      },
    };
    expect(await acquireWorkerLock(fakeRedis, "first")).toBe(true);
    expect(await acquireWorkerLock(fakeRedis, "second")).toBe(false);
    expect(await renewWorkerLock(fakeRedis, "first", 123)).toBe(true);
    await releaseWorkerLock(fakeRedis, "second");
    expect(owner as string | null).toBe("first");
    await releaseWorkerLock(fakeRedis, "first");
    expect(owner as string | null).toBeNull();
  });
  test("normalizes vehicle type-research responses without dropping the raw fields", () => {
    const raw = { availableFilters: { modelSeries: [{ searchTerm: "X'", displayTerm: "X'" }] }, typekeys: [{ typekey: "11EH", baseType: "11E", capacity: 2998 }], queryParameters: { filterByBrand: "BMW" }, futureField: true };
    expect(normalizeTypeResearchResponse(raw)).toEqual({
      availableFilters: raw.availableFilters,
      typekeys: raw.typekeys,
      raw,
    });
  });
  test("fetches both awSheet details even when typekey flags are false", async () => {
    const calls: string[] = [];
    const written: Array<{ key: string; value: unknown }> = [];
    const result = await fetchAwSheetDetails({
      async inklusivPositionen(typekey, oid) { calls.push(`inclusive:${typekey}:${oid}`); return [{ number: "1" }]; },
      async umfasstTexte(typekey, oid) { calls.push(`surrounding:${typekey}:${oid}`); return []; },
    }, "UD42", "oid-1", new Set(["11", "12"]), "root", async (key, value) => { written.push({ key, value }); }, 2);
    expect(calls).toEqual(["inclusive:UD42:oid-1", "surrounding:UD42:oid-1"]);
    expect(result).toMatchObject({ inclusiveCount: 1, umfasstCount: 0 });
    expect(written).toEqual([
      { key: "root/11/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
      { key: "root/12/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
    ]);
  });
  test("parses BMW catalog and flat-rate groups without transforming them", () => {
    const catalog = [{ id: "hg", number: "11", text: "Engine" }];
    const rates = { flatrateGroups: [{ flatrates: [{ awSheetOID: "123" }] }] };
    expect(catalogItems(catalog)).toEqual(catalog);
    expect(flatrateGroups(rates)).toEqual(rates.flatrateGroups);
  });
  test("locks down pretty-printed S3 JSON bytes consumed line-by-line by bmw-transformer", async () => {
    let stored = "";
    const adapter: S3Adapter = {
      async headBucket() {}, async createBucket() {}, async putObject(_key, body) { stored = String(body); },
      async getObject() { return stored; }, async signGet() { return "signed"; }, async list() { return { keys: [] }; }, async deleteObject() {},
    };
    await new S3Store({ adapter }).putJson("fixture.json", [{ id: "h", number: "11" }], true);
    expect(stored).toBe('[\n  {\n    "id": "h",\n    "number": "11"\n  }\n]');
  });
  test("patches request state atomically while preserving unrelated fields", async () => {
    let value: string | null = JSON.stringify({ requestId: "id", status: "running", error: "old", updatedAt: "old" });
    const fake = {
      async get() { return value; },
      async set(_key: string, body: string) { value = body; },
      async watch() { return "OK"; },
      async unwatch() { return "OK"; },
      multi() {
        let staged = "";
        return {
          set(_key: string, body: string) { staged = body; return this; },
          async exec() { value = staged; return [[null, "OK"]] as Array<[Error | null, unknown]>; },
        };
      },
    };
    const store = new RedisStateStore(fake, id => `job:${id}`, 60);
    const next = await store.patch("id", { status: "completed", error: undefined } as Partial<{ status: string; error?: string; updatedAt: string }>, ["error"]);
    expect(next).toMatchObject({ requestId: "id", status: "completed" });
    expect(next).not.toHaveProperty("error");
  });
  test("deduplicates awSheet OIDs while recording every HG", () => {
    const result = findAwSheetGroups(new Map([["11", [{ flatrates: [{ awSheetOID: "x" }] }]], ["12", [{ flatrates: [{ awSheetOID: "x" }] }]]]));
    expect([...result.get("x")!]).toEqual(["11", "12"]);
  });
});
