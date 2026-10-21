import { describe, expect, test } from "bun:test";
import { UnavailableError, UpstreamError, ValidationError } from "reader-core/domain/errors";
import { createModelOptionsUseCase } from "../src/application/use-cases/get-model-options.js";
import type { TypeResearchResult } from "../src/application/ports/vehicle-type-research.js";
import { createParsedModelOptionsHandler } from "../src/interfaces/http/model-options-handler.js";

const raw = {
  availableFilters: {
    modelSeries: ["7", { searchTerm: "G70", displayTerm: "7 Series (G70)" }, { value: "X5", label: "X5" }, null, {}, 7],
    empty: null,
    invalid: "not-an-array",
  },
  typekeys: [
    { typeCode: "11EH", baseType: "G70", displayTerm: "740i", model: "740i", displayType: "Sedan", catalogPaths: ["a", "b"] },
    null,
    "primitive",
    { typekey: "11eh", family: "G70" },
    { typekey: "11E", family: "G70" },
    { typekey: "21EH", family: "" },
    { typekey: "21EH" },
  ],
  futureField: { retained: true },
};

function isValidCachedSource(value: unknown): value is TypeResearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !!record.availableFilters && typeof record.availableFilters === "object" && !Array.isArray(record.availableFilters)
    && Array.isArray(record.typekeys) && "raw" in record;
}

function fixture(overrides: Partial<{
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<unknown>;
  isValidCachedSource: (value: unknown) => value is TypeResearchResult;
  discover: (query: { brand?: string; modelSeries?: string; developmentCode?: string; filterByType?: string; language: string }) => Promise<{ availableFilters: Record<string, unknown>; typekeys: unknown[]; raw: unknown }>;
}> = {}) {
  const keys: string[] = [];
  const writes: Array<{ key: string; value: string; expiry: "EX"; ttlSeconds: number }> = [];
  const discoverCalls: unknown[] = [];
  const discover = overrides.discover ?? (async () => ({ availableFilters: raw.availableFilters, typekeys: raw.typekeys, raw }));
  const dependencies = {
    get: overrides.get ?? (async (key: string) => { keys.push(key); return null; }),
    set: overrides.set ?? (async (key: string, value: string, ttlSeconds: number) => { writes.push({ key, value, expiry: "EX", ttlSeconds }); }),
    isValidCachedSource: overrides.isValidCachedSource ?? isValidCachedSource,
    discover: async (query: { brand?: string; modelSeries?: string; developmentCode?: string; filterByType?: string; language: string }) => {
      discoverCalls.push(query);
      return discover(query);
    },
  };
  return { useCase: createModelOptionsUseCase(dependencies), keys, writes, discoverCalls };
}

describe("BMW model options", () => {
  test("normalizes valid filters/models and preserves upstream attributes and raw payload", async () => {
    const { useCase, writes } = fixture();
    const result = await useCase({ language: "en-GB", manufacturer: "BMW", modelSeries: "7", includeRaw: true });

    expect(result).toMatchObject({
      manufacturer: "BMW",
      appliedFilters: { brand: "BMW", modelSeries: "7" },
      filters: [
        { name: "modelSeries", values: [{ value: "7", label: "7" }, { value: "G70", label: "7 Series (G70)" }, { value: "X5", label: "X5" }] },
        { name: "empty", values: [] },
        { name: "invalid", values: [] },
      ],
      models: [{
        id: "11EH",
        label: "740i",
        attributes: { displayType: "Sedan", catalogPaths: ["a", "b"] },
        selection: { series: "7", typekeys: [{ typekey: "11EH", family: "G70", model: "740i" }] },
      }],
      complete: false,
      raw,
    });
    expect(writes[0]).toMatchObject({ expiry: "EX", ttlSeconds: 86400 });
  });

  test("prefers the filtered developmentCode over BMW baseType when creating a family", async () => {
    const second = fixture({ discover: async () => ({ availableFilters: {}, typekeys: [{ typekey: "21EH", baseType: "21E", displayTerm: "X5" }], raw: {} }) });
    const result = await second.useCase({ language: "en-GB", developmentCode: "G05" });
    expect(result).toMatchObject({ models: [{ selection: { typekeys: [{ typekey: "21EH", family: "G05" }] } }] });
  });

  test("marks type-filtered results complete", async () => {
    const complete = fixture({ discover: async () => ({ availableFilters: {}, typekeys: [{ typekey: "21EH", family: "G05" }], raw: {} }) });
    expect(await complete.useCase({ language: "en-GB", filterByType: "21EH" })).toMatchObject({ complete: true });
  });

  test("rejects incompatible filterByType combinations without calling BMW", async () => {
    for (const query of [
      { language: "en-GB", brand: "BMW", filterByType: "11EH" },
      { language: "en-GB", modelSeries: "7", filterByType: "11EH" },
      { language: "en-GB", developmentCode: "G70", filterByType: "11EH" },
    ]) {
      const { useCase, discoverCalls } = fixture();
      await expect(useCase(query)).rejects.toBeInstanceOf(ValidationError);
      expect(discoverCalls).toHaveLength(0);
    }
  });

  test("does not use manufacturer as brand when querying by a typekey", async () => {
    const { useCase, discoverCalls } = fixture({ discover: async () => ({ availableFilters: {}, typekeys: [], raw: {} }) });
    const result = await useCase({ language: "en-GB", manufacturer: "MINI", filterByType: "11EH" });
    expect(discoverCalls).toEqual([{ language: "en-GB", manufacturer: "MINI", filterByType: "11EH", brand: undefined }]);
    expect(result).toMatchObject({ manufacturer: "MINI", appliedFilters: { filterByType: "11EH" } });
  });

  test("uses cache, canonicalizes key parameter order, and separates language/raw variants", async () => {
    const { useCase, keys, writes } = fixture();
    await useCase({ language: "en-GB", brand: "BMW", modelSeries: "7" });
    await useCase({ modelSeries: "7", brand: "BMW", language: "en-GB" });
    await useCase({ modelSeries: "7", brand: "BMW", language: "de-DE" });
    await useCase({ modelSeries: "7", brand: "BMW", language: "en-GB", includeRaw: true });
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(2);
    expect(writes).toHaveLength(4);
  });

  test("coalesces simultaneous discoveries across includeRaw response variants", async () => {
    const { useCase, discoverCalls, writes } = fixture({
      discover: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { availableFilters: {}, typekeys: [{ typekey: "11EH", family: "G70" }], raw };
      },
    });
    const [withoutRaw, withRaw] = await Promise.all([
      useCase({ language: "en-GB", brand: "BMW", includeRaw: false }),
      useCase({ language: "en-GB", brand: "BMW", includeRaw: true }),
    ]);
    expect(discoverCalls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(withoutRaw).not.toHaveProperty("raw");
    expect(withRaw).toMatchObject({ raw });
  });

  test("refreshes corrupt or obsolete cached JSON instead of returning an invalid response", async () => {
    let cached: string | null = "{";
    let calls = 0;
    const corruptCache = fixture({
      get: async () => cached,
      set: async (_key, value) => { cached = value; },
      discover: async () => ({ availableFilters: {}, typekeys: [{ typekey: "11EH", family: "G70" }], raw: {} }),
    });
    expect(await corruptCache.useCase({ language: "en-GB" })).toMatchObject({ models: [{ id: "11EH" }] });
    expect(await corruptCache.useCase({ language: "en-GB" })).toMatchObject({ models: [{ id: "11EH" }] });
    expect(corruptCache.discoverCalls).toHaveLength(1);

    const obsoleteCache = fixture({
      get: async () => JSON.stringify({ manufacturer: "BMW", models: [] }),
      discover: async () => { calls++; return { availableFilters: {}, typekeys: [{ typekey: "11EH", family: "G70" }], raw: {} }; },
    });
    expect(await obsoleteCache.useCase({ language: "en-GB" })).toMatchObject({ models: [{ id: "11EH" }] });
    expect(calls).toBe(1);
  });

  test("maps only BMW discovery failures to upstream errors; Redis write failures stay identifiable", async () => {
    const upstream = fixture({ discover: async () => { throw new Error("BMW offline"); } });
    await expect(upstream.useCase({ language: "en-GB" })).rejects.toBeInstanceOf(UpstreamError);

    const validation = fixture({ discover: async () => { throw new ValidationError("bad filter"); } });
    await expect(validation.useCase({ language: "en-GB" })).rejects.toBeInstanceOf(ValidationError);

    const unavailable = fixture({ discover: async () => { throw new UnavailableError("rate-limited", { retryAfterMs: 2000 }); } });
    await expect(unavailable.useCase({ language: "en-GB" })).rejects.toMatchObject({ code: "UNAVAILABLE", details: { retryAfterMs: 2000 } });

    const redis = fixture({ set: async () => { throw new Error("Redis unavailable"); } });
    await expect(redis.useCase({ language: "en-GB" })).rejects.toThrow("Redis unavailable");
  });

  test("validates query parameters and the normalized model-options contract", async () => {
    let calls = 0;
    const handler = createParsedModelOptionsHandler(
      async query => { calls++; return { availableFilters: {}, typekeys: [{ typekey: "11EH", family: "G70" }], raw: query }; },
      async () => null,
      async () => undefined,
    );
    const result = await handler({ manufacturer: "BMW", modelSeries: "7", includeRaw: "true" });
    expect(result).toMatchObject({ manufacturer: "BMW", models: [{ selection: { series: "7", typekeys: [{ typekey: "11EH", family: "G70" }] } }], raw: { language: "en-GB", manufacturer: "BMW", modelSeries: "7" } });
    for (const query of [{ includeRaw: "yes" }, { includeRaw: "1" }, { includeRaw: "TRUE" }, { brand: "" }, { modelSeries: "" }, { brand: ["BMW", "MINI"] }, { manufacturer: "AUDI" }]) {
      await expect(handler(query)).rejects.toHaveProperty("name", "ZodError");
    }
    expect(calls).toBe(1);
  });
});
