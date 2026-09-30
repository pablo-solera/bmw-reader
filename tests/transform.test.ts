import { describe, expect, test } from "bun:test";
import { flattenCatalog } from "../src/transform/catalog.js";
import { buildPivot, flattenFlatrates, findAwSheetGroups } from "../src/transform/flatrates.js";
import { extractSpecialEquipment, workTypeLabel } from "../src/transform/worktype.js";
import { ddaMismatch, ddaRule, normalizeOperation } from "../src/transform/dda.js";
import { quoteIdentifier } from "../src/db/bmw.js";
import { fetchAwSheetDetails, isUpstreamOutage, mapConcurrent, withFinalCheckpoint } from "../src/bmw/fetch-typekey.js";
import { normalizeTypeResearchResponse } from "../src/bmw/type-research.js";
import { bottleneckPermitDecision, rateLimitDecision, retryCooldownMs } from "../src/bmw/rate-limit.js";
import { acquireWorkerLock, releaseWorkerLock, renewWorkerLock } from "../src/worker-lock.js";
import { AccessTokenPool, nextTokenIndex, tokenExpiresAt } from "../src/bmw/auth.js";
import { summarizeMetrics } from "../src/rate-metrics.js";
import { transientRetryDelay } from "../src/bmw/client.js";
import { completedJobEvent, extractionJobId } from "../src/jobs.js";
import { finalizeTypekeyProgress } from "../src/bmw/fetch-typekey.js";

describe("BMW catalogue and labour transforms", () => {
  test("spaces Redis limiter permits and applies a shared cooldown", () => {
    expect(rateLimitDecision(1000, 1200, 333, 0, 25)).toEqual({ waitMs: 200, intervalMs: 333 });
    expect(rateLimitDecision(1000, 800, 500, 1500, 25)).toEqual({ waitMs: 500, intervalMs: 500 });
    expect(rateLimitDecision(1000, 1000, 25, 0, 25)).toEqual({ waitMs: 25, intervalMs: 25 });
  });
  test("retries 429 after Bottleneck's 500ms delay or Retry-After", () => {
    expect(retryCooldownMs()).toBe(500);
    expect(retryCooldownMs(90000, 500, 120000)).toBe(90000);
  });
  test("models Bottleneck reservoir of three per second with a 25ms minTime", () => {
    const first = bottleneckPermitDecision(1000, undefined, undefined, 1000, 0);
    expect(first).toEqual({ waitMs: 0, windowStart: 1000, remaining: 2, nextAt: 1025 });
    const second = bottleneckPermitDecision(1025, first.windowStart, first.remaining, first.nextAt, 0);
    const third = bottleneckPermitDecision(1050, second.windowStart, second.remaining, second.nextAt, 0);
    expect([second.remaining, third.remaining]).toEqual([1, 0]);
    const fourth = bottleneckPermitDecision(1075, third.windowStart, third.remaining, third.nextAt, 0);
    expect(fourth.waitMs).toBe(925);
    expect(bottleneckPermitDecision(1075, third.windowStart, third.remaining, third.nextAt, 1200).waitMs).toBe(125);
  });
  test("summarizes requests, 429s and completed OIDs per minute", () => {
    const now = 10 * 60_000 + 30_000;
    expect(summarizeMetrics([
      { minute: 6, requests: 60, permits: 62, rateLimited: 3, completedOids: 25, bmwLatencyMs: 0, bmwLatencyCount: 0, s3PutMs: 0, s3Puts: 0 },
      { minute: 10, requests: 30, permits: 31, rateLimited: 0, completedOids: 15, bmwLatencyMs: 0, bmwLatencyCount: 0, s3PutMs: 0, s3Puts: 0 },
    ], now, 5)).toEqual({
      windowMinutes: 5,
      requests: 90,
      permits: 93,
      permitsPerSecond: 0.31,
      requestsPerSecond: 0.3,
      rateLimited: 3,
      rateLimitedPercentage: 3.23,
      completedOids: 40,
      completedOidsPerMinute: 8,
      avgBmwLatencyMs: 0,
      avgS3PutMs: 0,
      s3Puts: 0,
    });
  });
  test("calculates average BMW and S3 latencies", () => {
    expect(summarizeMetrics([{ minute: 10, requests: 2, permits: 2, rateLimited: 0, completedOids: 1, bmwLatencyMs: 1200, bmwLatencyCount: 2, s3PutMs: 600, s3Puts: 3 }], 10 * 60000 + 5000, 1)).toMatchObject({ avgBmwLatencyMs: 600, avgS3PutMs: 200, s3Puts: 3 });
  });
  test("recognizes consecutive upstream failures and always checkpoints on error", async () => {
    expect(isUpstreamOutage([true, false, false])).toBe(false);
    expect(isUpstreamOutage([true, false, false, false])).toBe(true);
    let checkpointed = false;
    await expect(withFinalCheckpoint(async () => { throw new Error("failure"); }, async () => { checkpointed = true; })).rejects.toThrow("failure");
    expect(checkpointed).toBe(true);
  });
  test("bounds transient 5xx retries by time and honors Retry-After", () => {
    expect(transientRetryDelay(0, 0, 600000, 0, 100)).toBe(1100);
    expect(transientRetryDelay(5000, 1, 600000, 12000, 100)).toBe(12000);
    expect(transientRetryDelay(599000, 6, 600000, 0, 1000)).toBe(1000);
    expect(transientRetryDelay(600000, 6, 600000)).toBeNull();
  });
  test("uses unique execution-scoped IDs when resuming a typekey job", () => {
    expect(extractionJobId("request", "run-one", 0)).not.toBe(extractionJobId("request", "run-two", 0));
    expect(extractionJobId("request", "run-one", 0)).toBe("request--run-one--0");
  });
  test("labels the BullMQ completed event separately from full extraction completion", () => {
    expect(completedJobEvent("request", "21EJ", { kind: "typekey" })).toEqual({ event: "extraction_job_completed", requestId: "request", typekey: "21EJ", result: { kind: "typekey" } });
  });
  test("writes completion marker before deleting progress and tolerates cleanup failures", async () => {
    const calls: string[] = [];
    await finalizeTypekeyProgress("typekey/completed.json", "root/_progress/21EJ", { typekey: "21EJ", date: "20260928", hgs: 34, awSheetOIDs: 2557, completedAt: "2026-09-28T00:00:00.000Z", requestId: "request" }, async key => { calls.push(`put:${key}`); }, async prefix => { calls.push(`delete:${prefix}`); return 1; });
    expect(calls).toEqual(["put:typekey/completed.json", "delete:root/_progress/21EJ"]);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(finalizeTypekeyProgress("done", "progress", { typekey: "21EJ", date: "20260928", hgs: 0, awSheetOIDs: 0, completedAt: "now", requestId: "request" }, async () => {}, async () => { throw new Error("S3 unavailable"); return 0; })).resolves.toBeUndefined();
    } finally { console.warn = originalWarn; }
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
      async set(_key: string, value: string, _expiry: "PX", _ttlMs: number, _condition: "NX") { if (owner) return null; owner = value; return "OK"; },
      async eval(script: string, _keyCount: number, ...args: Array<string | number>) {
        if (script.includes("PEXPIRE")) return owner === args[2] ? 1 : 0;
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
      queryParameters: raw.queryParameters,
      raw,
    });
  });
  test("fetches both awSheet details even when typekey flags are false", async () => {
    const calls: string[] = [];
    const written: Array<{ key: string; value: unknown }> = [];
    const result = await fetchAwSheetDetails({
      async inklusivPositionen(typekey, oid) { calls.push(`inclusive:${typekey}:${oid}`); return [{ number: "1" }]; },
      async umfasstTexte(typekey, oid) { calls.push(`surrounding:${typekey}:${oid}`); return []; },
    }, "UD42", "oid-1", new Set(["11", "12"]), "root", async (key, value) => { written.push({ key, value }); });
    expect(calls).toEqual(["inclusive:UD42:oid-1", "surrounding:UD42:oid-1"]);
    expect(result).toMatchObject({ inclusiveCount: 1, umfasstCount: 0 });
    expect(written).toEqual([
      { key: "root/11/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
      { key: "root/12/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
    ]);
  });
  test("flattens nested catalogue entries", () => {
    expect(flattenCatalog("UD42", [{ id: "hg", number: "11", text: "Engine", entries: [{ id: "a_b", number: "01", text: "Oil" }] }])).toEqual([
      { typekey: "UD42", id: "hg", number: "11", text: "Engine", entriesId: "a_b", entriesNumber: "01", entriesText: "Oil" },
    ]);
  });
  test("preserves all catalog paths, displayType and flatrate values", () => {
    const rows = flattenFlatrates("UD42", [{ catalogPaths: ["entry_a", "entry_b"], orderNumber: "1", flatrates: [{ awSheetOID: "123", displayType: "DEFAULT", number: "0000001", value: 8, validityExpression: "true" }] }]);
    expect(rows[0]?.catalogPaths).toEqual(["entry_a", "entry_b"]);
    expect(rows[0]?.flatrate).toMatchObject({ displayType: "DEFAULT", value: 8 });
  });
  test("pivots rates across types using each path without LIKE wildcards", () => {
    const catalog = new Map([["UD42", flattenCatalog("UD42", [{ id: "h", number: "11", text: "Engine", entries: [{ id: "entry_a", number: "1", text: "Oil" }] }])]]);
    const rates = new Map([["UD42", flattenFlatrates("UD42", [{ catalogPaths: ["path_entry_a%00"], rubrikText: "Engine", flatrates: [{ awSheetOID: "123", number: "0000001", value: 8, workType: "HAUPTARBEIT" }] }])]]);
    const pivot = buildPivot(catalog, rates);
    expect(pivot).toHaveLength(1);
    expect(pivot[0]?.values).toEqual({ UD42: "8" });
  });
  test("does not confuse entries that share a prefix", () => {
    const catalog = new Map([["UD42", flattenCatalog("UD42", [{ id: "h", number: "11", text: "Engine", entries: [{ id: "entry_a", number: "1", text: "Oil" }] }])]]);
    const rates = new Map([["UD42", flattenFlatrates("UD42", [{ catalogPaths: ["prefix_entry_ab%00"], flatrates: [{ awSheetOID: "123", number: "0000001", value: 8 }] }])]]);
    expect(buildPivot(catalog, rates)).toHaveLength(0);
  });
  test("deduplicates awSheet OIDs while recording every HG", () => {
    const result = findAwSheetGroups(new Map([["11", [{ flatrates: [{ awSheetOID: "x" }] }]], ["12", [{ flatrates: [{ awSheetOID: "x" }] }]]]));
    expect([...result.get("x")!]).toEqual(["11", "12"]);
  });
});

describe("legacy-compatible BMW comparison helpers", () => {
  test("quotes only simple SQL identifiers", () => {
    expect(quoteIdentifier("J01_20250121")).toBe("[J01_20250121]");
    expect(() => quoteIdentifier("J01]; DROP TABLE Peticiones;--")).toThrow();
  });
  test("translates known work types and retains special-equipment suffix", () => {
    expect(workTypeLabel("HAUPTARBEIT S5AC")).toBe("T.P. S5AC");
    expect(workTypeLabel("VERBUNDARBEIT")).toBe("T.A.");
    expect(workTypeLabel("PLUSARBEIT")).toBe("P.P");
  });
  test("extracts Sonderausstattung code", () => {
    expect(extractSpecialEquipment("Sonderausstattung ('S5AC')")).toBe("S5AC");
  });
  test("normalizes DDA operations and applies exact, inclusive and ZAX rules", () => {
    expect(normalizeOperation("51 76 546) ZAX")).toBe("5176546");
    expect(ddaRule("51 76 546")).toBe("exact");
    expect(ddaMismatch("51 76 546", 5, 6)).toBe(true);
    expect(ddaMismatch("51 76 546)", 5, 6)).toBe(false);
    expect(ddaMismatch("51 76 546)", 6, 6)).toBe(true);
    expect(ddaMismatch("51 76 546 ZAX", 5, 6)).toBe(true);
    expect(ddaMismatch("51 76 546 ZAX", 5, "")).toBe(false);
  });
});
