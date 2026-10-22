import { describe, expect, test } from "bun:test";
import { NotAvailableError } from "reader-core/domain/errors";
import { withCachedCatalog } from "../src/application/bmw/cached-catalog-client.js";
import type { CatalogCache } from "../src/application/ports/catalog-cache.js";
import { assertTypekeysAvailable, checkTypekeyAvailability } from "../src/application/use-cases/check-typekey-availability.js";
import { enqueueLabourUseCase, type EnqueueLabourDependencies } from "../src/application/use-cases/enqueue-labour.js";
import { TypekeyUnavailableError } from "../src/domain/labour/errors.js";
import { createRedisCatalogCache } from "../src/infrastructure/redis/catalog-cache.js";

function memoryCache(): CatalogCache & { catalogs: Map<string, unknown>; unavailable: Set<string> } {
  const catalogs = new Map<string, unknown>();
  const unavailable = new Set<string>();
  const id = (typekey: string, language: string) => `${language}:${typekey}`;
  return {
    catalogs, unavailable,
    getCatalog: async (typekey, language) => catalogs.get(id(typekey, language)),
    setCatalog: async (typekey, language, catalog) => { catalogs.set(id(typekey, language), catalog); },
    isUnavailable: async (typekey, language) => unavailable.has(id(typekey, language)),
    markUnavailable: async (typekey, language) => { unavailable.add(id(typekey, language)); },
  };
}

describe("typekey availability check", () => {
  test("classifies available, unavailable and unknown typekeys and caches definitive answers", async () => {
    const cache = memoryCache();
    const calls: string[] = [];
    const dependencies = {
      cache,
      fetchCatalog: async (typekey: string) => {
        calls.push(typekey);
        if (typekey === "YM13") throw new TypekeyUnavailableError(typekey);
        if (typekey === "DOWN") throw new Error("BMW is down");
        return [{ id: "1", number: "01", text: "Engine" }];
      },
    };
    expect(await checkTypekeyAvailability("6J92", "en-GB", dependencies)).toBe("available");
    expect(await checkTypekeyAvailability("YM13", "en-GB", dependencies)).toBe("unavailable");
    expect(await checkTypekeyAvailability("DOWN", "en-GB", dependencies)).toBe("unknown");
    expect(cache.catalogs.has("en-GB:6J92")).toBe(true);
    expect(cache.unavailable.has("en-GB:YM13")).toBe(true);
    expect(cache.catalogs.has("en-GB:DOWN") || cache.unavailable.has("en-GB:DOWN")).toBe(false);

    calls.length = 0;
    expect(await checkTypekeyAvailability("6J92", "en-GB", dependencies)).toBe("available");
    expect(await checkTypekeyAvailability("YM13", "en-GB", dependencies)).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  test("does not cache empty catalogs from BMW 404 responses", async () => {
    const cache = memoryCache();
    expect(await checkTypekeyAvailability("0000", "en-GB", { cache, fetchCatalog: async () => [] })).toBe("available");
    expect(cache.catalogs.size).toBe(0);
  });

  test("keeps working when the cache itself fails", async () => {
    const broken: CatalogCache = {
      getCatalog: async () => { throw new Error("redis down"); }, setCatalog: async () => { throw new Error("redis down"); },
      isUnavailable: async () => { throw new Error("redis down"); }, markUnavailable: async () => { throw new Error("redis down"); },
    };
    expect(await checkTypekeyAvailability("6J92", "en-GB", { cache: broken, fetchCatalog: async () => [{ id: "1" }] })).toBe("available");
    expect(await checkTypekeyAvailability("YM13", "en-GB", { cache: broken, fetchCatalog: async () => { throw new TypekeyUnavailableError("YM13"); } })).toBe("unavailable");
  });

  test("rejects with a NOT_AVAILABLE error listing only the unavailable typekeys", async () => {
    const dependencies = {
      cache: memoryCache(),
      fetchCatalog: async (typekey: string) => { if (["YM13", "6J02"].includes(typekey)) throw new TypekeyUnavailableError(typekey); return [{ id: "1" }]; },
    };
    const error = await assertTypekeysAvailable(["6J92", "YM13", "6J02", "YM13"], "en-GB", dependencies).catch(value => value);
    expect(error).toBeInstanceOf(NotAvailableError);
    expect(error).toMatchObject({
      code: "NOT_AVAILABLE",
      message: "Typekeys YM13, 6J02 no disponibles en BMW Flat Rates (CGWATB0085)",
      details: { typekeys: [{ typekey: "YM13", code: "CGWATB0085" }, { typekey: "6J02", code: "CGWATB0085" }] },
    });
    await expect(assertTypekeysAvailable(["YM13"], "en-GB", dependencies)).rejects.toThrow("Typekey YM13 no disponible en BMW Flat Rates (CGWATB0085)");
    await expect(assertTypekeysAvailable(["6J92"], "en-GB", dependencies)).resolves.toBeUndefined();
  });

  test("lets the worker reuse a cached catalog instead of calling BMW again", async () => {
    const cache = memoryCache();
    await cache.setCatalog("6J92", "en-GB", [{ id: "cached" }]);
    let bmwCalls = 0;
    const api = withCachedCatalog({
      catalog: async () => { bmwCalls++; return [{ id: "fresh" }]; },
      flatRates: async () => [], inklusivPositionen: async () => [], umfasstTexte: async () => [],
    }, cache, "en-GB");
    expect(await api.catalog("6J92")).toEqual([{ id: "cached" }]);
    expect(await api.catalog("YM01")).toEqual([{ id: "fresh" }]);
    expect(bmwCalls).toBe(1);
  });

  test("stores catalogs for one hour and unavailable markers for one day under bmw-reader keys", async () => {
    const values = new Map<string, { value: string; ttl: number }>();
    const cache = createRedisCatalogCache({
      get: async (key: string) => values.get(key)?.value ?? null,
      set: async (key: string, value: string, _mode: "EX", ttl: number) => { values.set(key, { value, ttl }); return "OK"; },
    } as never);
    await cache.setCatalog("6J92", "en-GB", [{ id: "1" }]);
    await cache.markUnavailable("YM13", "en-GB");
    expect(values.get("bmw-reader:catalog:en-GB:6J92")?.ttl).toBe(3600);
    expect(values.get("bmw-reader:catalog-unavailable:en-GB:YM13")?.ttl).toBe(86400);
    expect(await cache.getCatalog("6J92", "en-GB")).toEqual([{ id: "1" }]);
    expect(await cache.getCatalog("YM13", "en-GB")).toBeUndefined();
    expect(await cache.isUnavailable("YM13", "en-GB")).toBe(true);
  });
});

describe("enqueue precheck", () => {
  const input = { manufacturer: "BMW", series: "6", typekeys: [{ typekey: "YM13", family: "F13" }, { typekey: "6J92", family: "F13" }] };
  function dependencies(overrides: Partial<EnqueueLabourDependencies>, calls: string[]): EnqueueLabourDependencies {
    return {
      getState: async () => null,
      saveState: async value => { calls.push("save"); return value; },
      deleteState: async () => undefined,
      claimTypekeyPaths: async (_id, labour) => { calls.push("claim"); return labour.typekeys.map(item => item.typekey); },
      releaseTypekeyPaths: async () => undefined,
      isCancelling: async () => false,
      queue: { enqueue: async (_data, jobId) => { calls.push("enqueue"); return { id: jobId }; }, getJob: async () => null },
      newId: () => "run-id",
      now: () => new Date("2026-10-22T00:00:00Z"),
      ...overrides,
    };
  }

  test("rejects before claiming locks, saving state or queueing when a typekey is unavailable", async () => {
    const calls: string[] = [];
    const checked: Array<{ typekeys: string[]; language: string | undefined }> = [];
    const failing = dependencies({
      assertTypekeysAvailable: async (typekeys, language) => { checked.push({ typekeys, language }); throw new NotAvailableError("Typekey YM13 no disponible en BMW Flat Rates (CGWATB0085)"); },
    }, calls);
    await expect(enqueueLabourUseCase({ ...input, language: "de-DE" }, failing, 0, "request-id")).rejects.toBeInstanceOf(NotAvailableError);
    expect(checked).toEqual([{ typekeys: ["YM13", "6J92"], language: "de-DE" }]);
    expect(calls).toEqual([]);
  });

  test("enqueues normally when every typekey is available and skips the precheck for existing requests", async () => {
    const calls: string[] = [];
    let prechecks = 0;
    await enqueueLabourUseCase(input, dependencies({ assertTypekeysAvailable: async () => { prechecks++; } }, calls), 0, "request-id");
    expect(calls).toEqual(["claim", "save", "enqueue"]);
    expect(prechecks).toBe(1);

    const resumed = dependencies({
      assertTypekeysAvailable: async () => { prechecks++; throw new Error("must not run on replacement attempts"); },
      getState: async requestId => ({ requestId, status: "failed", stage: "failed", progress: 0, createdAt: "now", updatedAt: "now" }),
    }, []);
    await enqueueLabourUseCase(input, resumed, 0, "request-id");
    expect(prechecks).toBe(1);
  });
});
