import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BmwClient, BmwRateLimitWaitTimeoutError } from "../src/infrastructure/bmw/client.js";
import { catalogHgNumbers, catalogItems, findAwSheetGroups, flatrateGroups } from "../src/application/bmw/parse.js";
import { fetchAwSheetDetails } from "../src/application/use-cases/fetch-typekey.js";
import { normalizeTypeResearchResponse } from "../src/infrastructure/bmw/type-research.js";
import { loadConfig } from "../src/config.js";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function client(options: { acquire?: (signal?: AbortSignal) => Promise<void> } = {}) {
  const env = { BMW_API_CLIENT_ID: "test-client", BMW_API_CLIENT_SECRET: "test-secret", BMW_API_KEY: "test-api-key" };
  const settings = loadConfig({ ...env, BMW_API_TIMEOUT_MS: "500", BMW_5XX_RETRY_WINDOW_MS: "1" });
  const tokenProvider = { getAccessToken: async () => "token", renewAccessToken: async () => "renewed" };
  const limiter = { acquire: options.acquire ?? (async () => undefined), report429: async () => ({ waitMs: 0, count: 1 }) };
  return new BmwClient({ settings, language: "en-GB", tokenProvider: tokenProvider as never, rateLimiter: limiter });
}

describe("BMW response validation and parsing", () => {
  test("normalizes missing or malformed type-research fields without discarding raw data", () => {
    for (const response of [null, undefined, [], "bad", 4]) {
      expect(normalizeTypeResearchResponse(response)).toEqual({ availableFilters: {}, typekeys: [], raw: response });
    }
    const raw = { availableFilters: [], typekeys: {}, queryParameters: { filterByBrand: "BMW" }, extra: true };
    expect(normalizeTypeResearchResponse(raw)).toEqual({ availableFilters: {}, typekeys: [], raw });
    expect(normalizeTypeResearchResponse({ availableFilters: { series: ["7"] }, typekeys: [{ typekey: "11EH" }], extra: true })).toMatchObject({
      availableFilters: { series: ["7"] }, typekeys: [{ typekey: "11EH" }], raw: { extra: true },
    });
  });

  test("returns empty collections for 404 and safely normalizes malformed catalogue payloads", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await client().catalog("21EH");
    expect(result).toEqual([]);
    expect(catalogItems(result)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);

    for (const value of [null, undefined, {}, "not-an-array", 4, [null, false, "row", 2]]) {
      expect(catalogItems(value)).toEqual([]);
    }
    expect(catalogItems([["nested"]])).toEqual([]);
    expect(catalogHgNumbers([
      { number: "11", id: "a", text: "valid" },
      { number: "11", id: "b", text: "duplicate" },
      { number: "../escape", id: "unsafe", text: "unsafe" },
      { number: "", id: "empty", text: "empty" },
      { number: "G70-HG", id: "safe", text: "safe" },
      { number: 12, id: "numeric", text: "numeric" },
      { number: null as never, id: "malformed", text: "malformed" },
    ] as never)).toEqual(["11", "G70-HG", "12"]);
  });

  test("maps 404 flat-rate responses to empty arrays and does not write empty AW details", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    expect(await client().flatRates("11EH", "11")).toEqual([]);

    const writes: string[] = [];
    const details = await fetchAwSheetDetails({
      inklusivPositionen: async () => [],
      umfasstTexte: async () => [],
    }, "11EH", "oid-1", new Set(["11"]), "root", async key => { writes.push(key); }, 2);
    expect(details).toMatchObject({ inclusiveCount: 0, umfasstCount: 0 });
    expect(writes).toEqual([]);
  });

  test("filters malformed flat-rate groups and ignores missing or empty AW sheet identifiers", () => {
    expect(flatrateGroups(null)).toEqual([]);
    expect(flatrateGroups([])).toEqual([]);
    expect(flatrateGroups({})).toEqual([]);
    expect(flatrateGroups({ flatrateGroups: "bad" })).toEqual([]);
    expect(flatrateGroups({ flatrateGroups: [null, "bad", [], {}, { flatrates: [{ awSheetOID: "oid-1" }] }] })).toEqual([{}, { flatrates: [{ awSheetOID: "oid-1" }] }]);
    expect(findAwSheetGroups(new Map([["11", [
      {},
      { flatrates: [null, {}, { awSheetOID: "" }, { awSheetOID: undefined }, { awSheetOID: "../escape" }, { awSheetOID: "oid-1" }] },
    ] as never]]))).toEqual(new Map([["oid-1", new Set(["11"])]]));
  });

  test("throws a BMW API error for non-JSON success responses", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>upstream proxy</html>", { status: 200 }));
    await expect(client().catalog("11EH")).rejects.toMatchObject({ name: "BmwApiError", status: 200, message: expect.stringContaining("invalid JSON") });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("preserves JSON null and malformed object responses for the tolerant parsing layer", async () => {
    spyOn(globalThis, "fetch").mockImplementation((async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    expect(await client().catalog("11EH")).toBeNull();
    expect(catalogItems(await client().catalog("11EH"))).toEqual([]);
  });

  test("does not retry non-transient 400, 403, or 500 responses", async () => {
    for (const status of [400, 403, 500]) {
      const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("request rejected", { status }));
      await expect(client().catalog("11EH")).rejects.toMatchObject({ name: "BmwApiError", status, retryWindowExhausted: false });
      expect(request).toHaveBeenCalledTimes(1);
      request.mockRestore();
    }
  });

  test("renews at most once after repeated 401 responses", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    await expect(client().catalog("11EH")).rejects.toMatchObject({ name: "BmwApiError", status: 401 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("URL-encodes AW sheet identifiers and always sends typeCode", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    await client().inklusivPositionen("11EH", "OID/with?reserved");
    const [url] = request.mock.calls[0]!;
    expect(String(url)).toContain("inklusivpositionen/OID%2Fwith%3Freserved");
    expect(new URL(String(url)).searchParams.get("typeCode")).toBe("11EH");
  });

  test("bounds model-discovery waiting for a shared rate-limit cooldown", async () => {
    const limitedClient = client({
      acquire: signal => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("rate limiter wait aborted")), { once: true });
      }),
    });
    await expect(limitedClient.vehicleAttributes({}, 5)).rejects.toBeInstanceOf(BmwRateLimitWaitTimeoutError);
  });
});
