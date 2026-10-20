import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { BmwClient } from "../src/bmw/client.js";
import { createFetchTypekey, type FetchTypekeyServices } from "../src/bmw/fetch-typekey.js";
import { createBmwRateLimiter } from "../src/bmw/rate-limit.js";
import { loadConfig } from "../src/config.js";
import type { TypekeyProgressStore } from "../src/typekey-progress.js";
import type { ExtractionInput } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BMW HTTP client and shared limiter", () => {
  function client(options: { onRateLimitChange?: ConstructorParameters<typeof BmwClient>[2] } = {}) {
    const env = {
      BMW_API_CLIENT_ID: "test-client",
      BMW_API_CLIENT_SECRET: "test-secret",
      BMW_API_KEY: "test-api-key",
    };
    const settings = loadConfig({ ...env, BMW_API_TIMEOUT_MS: "500", BMW_5XX_RETRY_WINDOW_MS: "1" });
    let token = "token-one";
    const tokenProvider = {
      getAccessToken: async () => token,
      renewAccessToken: async (rejected?: string) => { expect(rejected).toBe("token-one"); token = "token-two"; return token; },
    };
    const limiter = {
      acquire: async () => undefined,
      report429: async () => ({ waitMs: 0, count: 1 }),
    };
    return new BmwClient(settings, "en-GB", options.onRateLimitChange, undefined, tokenProvider as never, limiter, env);
  }

  test("sends typeCode and maps BMW 404 to an empty collection", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    expect(await client().catalog("21EH")).toEqual([]);
    const [url, init] = request.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("typeCode")).toBe("21EH");
    expect(new URL(String(url)).searchParams.get("language")).toBe("en-GB");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-one");
  });

  test("renews once after 401 and retries with the refreshed token", async () => {
    const seenTokens: string[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      seenTokens.push((init?.headers as Record<string, string>).Authorization);
      return seenTokens.length === 1
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify([{ number: "001" }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    expect(await client().catalog("11EH")).toEqual([{ number: "001" }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(seenTokens).toEqual(["Bearer token-one", "Bearer token-two"]);
  });

  test("marks a 5xx retry window as exhausted for the job policy", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream down", { status: 502 }));
    await expect(client().catalog("11EH")).rejects.toMatchObject({ name: "BmwApiError", retryWindowExhausted: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("uses Redis Lua for shared rate reservations and 429 cooldown reporting", async () => {
    const calls: Array<{ script: string; keys: string[]; args: Array<string | number> }> = [];
    let acquireResults = [5, 0];
    const redis = {
      async eval(script: string, keyCount: number, ...args: Array<string | number>) {
        calls.push({ script, keys: args.slice(0, keyCount).map(String), args: args.slice(keyCount) });
        if (keyCount === 5) return acquireResults.shift() ?? 0;
        if (keyCount === 3) return [500, 2, 1];
        return 1;
      },
    };
    const limiter = createBmwRateLimiter(redis, { BMW_RATE_LIMIT_PER_SEC: 3, BMW_RATE_LIMIT_MAX_COOLDOWN_MS: 1800000, BMW_RATE_LIMIT_MIN_TIME_MS: 25 });
    await limiter.acquire(undefined, "interactive");
    expect(calls.slice(0, 2).every(call => call.keys[0] === "bmw-reader:rate:cooldown")).toBe(true);
    expect(calls[0]?.keys[4]).toBe("bmw-reader:rate:waiters");
    expect(calls[0]?.args[2]).toBe("interactive");
    expect(calls[0]?.script).toContain("redis.call('TIME')");
    expect(calls[0]?.script).toContain("now - window_start >= 1000");
    expect(calls[0]?.script).toContain("priority * 10000000000000 + now");
    expect(await limiter.report429(1200)).toEqual({ waitMs: 500, count: 2 });
    expect(calls[2]?.keys).toEqual(["bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:last-log"]);
  });
});

describe("fetchTypekey pipeline", () => {
  test("fetches catalog, HG rates and OID details, then writes the marker last", async () => {
    const objects = new Map<string, unknown>();
    const writes: Array<{ kind: string; key: string }> = [];
    const completed = new Set<string>();
    let cleared = false;
    const progressStore: TypekeyProgressStore = {
      initialize: async path => ({ path, startedAt: "2026-10-09T00:00:00.000Z", requestId: "request-1", axCode: null, edition: null, language: "en-GB", inklusivPositionenFiles: 0, umfasstTexteFiles: 0 }),
      metadata: async path => ({ path, startedAt: "2026-10-09T00:00:00.000Z", requestId: "request-1", axCode: null, edition: null, language: "en-GB", inklusivPositionenFiles: 1, umfasstTexteFiles: 1 }),
      completed: async () => [...completed],
      failures: async () => ({}),
      fatalError: async () => null,
      recordCompleted: async (_path, oid) => { completed.add(oid); return true; },
      recordFailed: async () => undefined,
      recordIncompleteFailure: async () => undefined,
      clear: async () => { cleared = true; writes.push({ kind: "checkpoint-clear", key: "progress" }); },
    };
    const settings = loadConfig({});
    const services: FetchTypekeyServices = {
      settings,
      progressStore,
      objectKey: (...parts) => parts.join("/"),
      putJson: async (key, value) => { objects.set(key, value); writes.push({ kind: "json", key }); },
      putJsonCompact: async (key, value) => { objects.set(key, value); writes.push({ kind: "marker", key }); },
      getJsonIfExists: async <T>(key: string) => objects.get(key) as T | undefined,
      deletePrefix: async () => 0,
    };
    const calls: string[] = [];
    const fakeClient = {
      catalog: async () => { calls.push("catalog"); return [{ id: "catalog-1", number: "001", text: "Engine", displayType: "Sedan", catalogPaths: ["path-one", "path-two"] }]; },
      flatRates: async () => { calls.push("flat-rates"); return { flatrateGroups: [{ flatrates: [{ awSheetOID: "OID-1" }] }] }; },
      inklusivPositionen: async () => { calls.push("inklusivpositionen"); return [{ code: "P1" }]; },
      umfasstTexte: async () => { calls.push("umfassttexte"); return [{ text: "T1" }]; },
    } as unknown as BmwClient;
    const input: ExtractionInput = { manufacturer: "BMW", series: "7'", family: "G70", edition: "20261009" };

    const result = await createFetchTypekey(services)(fakeClient, input, "11EH", "request-1", new Date("2026-10-09T00:00:00.000Z"), undefined, false);

    expect(result).toMatchObject({ typekey: "11EH", hgs: 1, awSheetOIDs: 1, completedAwSheetOIDs: 1, remainingAwSheetOIDs: 0 });
    expect(calls).toEqual(["catalog", "flat-rates", "inklusivpositionen", "umfassttexte"]);
    const markerIndex = writes.findIndex(write => write.kind === "marker");
    expect(markerIndex).toBeGreaterThan(0);
    expect(writes[markerIndex]?.key).toBe("BMW/BMW/labour/7/G70/20261009/11EH/11EH_completed.json");
    expect(writes.at(-1)).toEqual({ kind: "checkpoint-clear", key: "progress" });
    expect(cleared).toBe(true);
    expect(objects.has("BMW/BMW/labour/7/G70/20261009/11EH/001/OID-1_inklusivpositionen.json")).toBe(true);
    expect(objects.has("BMW/BMW/labour/7/G70/20261009/11EH/001/OID-1_umfassttexte.json")).toBe(true);
    expect(objects.get("BMW/BMW/labour/7/G70/20261009/11EH/11EH_catalog.json")).toEqual([{ id: "catalog-1", number: "001", text: "Engine", displayType: "Sedan", catalogPaths: ["path-one", "path-two"] }]);

    objects.delete("BMW/BMW/labour/7/G70/20261009/11EH/11EH_completed.json");
    completed.clear();
    calls.length = 0;
    await createFetchTypekey(services)(fakeClient, input, "11EH", "request-2", new Date("2026-10-09T00:00:00.000Z"), undefined, true);
    expect(calls).toEqual(["inklusivpositionen", "umfassttexte"]);

    const requestsBeforeMissingSeries = calls.length;
    await expect(createFetchTypekey(services)(fakeClient, { ...input, series: undefined }, "11EH", "request-1", new Date("2026-10-09T00:00:00.000Z"))).rejects.toThrow("series contains invalid path characters");
    expect(calls).toHaveLength(requestsBeforeMissingSeries);
  });
});
