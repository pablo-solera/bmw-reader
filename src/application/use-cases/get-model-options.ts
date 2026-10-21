import { createHash } from "node:crypto";
import { UnavailableError, UpstreamError, ValidationError } from "reader-core/domain/errors";
import type { TypeResearchQuery, TypeResearchResult } from "../ports/vehicle-type-research.js";

export type ModelOptionsDependencies = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  isValidCachedSource(value: unknown): value is TypeResearchResult;
  discover(query: TypeResearchQuery): Promise<TypeResearchResult>;
};

export function createModelOptionsUseCase(dependencies: ModelOptionsDependencies) {
  const inFlight = new Map<string, Promise<TypeResearchResult>>();
  return async function getModelOptions(query: TypeResearchQuery & { manufacturer?: string; includeRaw?: boolean }) {
    const effectiveBrand = query.filterByType ? query.brand : query.brand ?? query.manufacturer;
    if (query.filterByType && (effectiveBrand || query.modelSeries || query.developmentCode)) {
      throw new ValidationError("filterByType cannot be combined with brand, modelSeries or developmentCode");
    }
    const cacheQuery = {
      language: query.language,
      ...(effectiveBrand ? { brand: effectiveBrand } : {}),
      ...(query.modelSeries ? { modelSeries: query.modelSeries } : {}),
      ...(query.developmentCode ? { developmentCode: query.developmentCode } : {}),
      ...(query.filterByType ? { filterByType: query.filterByType } : {}),
    };
    const cacheKey = `bmw-reader:vehicle-options:${createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(cacheQuery).sort(([left], [right]) => left.localeCompare(right))))).digest("hex")}`;
    const cached = await dependencies.get(cacheKey);
    let result: TypeResearchResult | undefined;
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (dependencies.isValidCachedSource(parsed)) result = parsed;
      } catch {
        // Ignore corrupt or obsolete cache entries and refresh them from BMW.
      }
    }
    if (!result) {
      const active = inFlight.get(cacheKey);
      if (active) result = await active;
      else {
        const discovery = (async () => {
          let discovered: TypeResearchResult;
          try {
            discovered = await dependencies.discover({ ...query, brand: effectiveBrand });
          } catch (error) {
            if (error instanceof ValidationError || error instanceof UnavailableError) throw error;
            throw new UpstreamError("BMW Vehicle Type Research request failed", undefined, { cause: error });
          }
          const cacheable = { ...discovered, raw: discovered.raw ?? null };
          await dependencies.set(cacheKey, JSON.stringify(cacheable), 86400);
          return cacheable;
        })();
        inFlight.set(cacheKey, discovery);
        try { result = await discovery; }
        finally { if (inFlight.get(cacheKey) === discovery) inFlight.delete(cacheKey); }
      }
    }
    if (!result) throw new Error("Model discovery completed without a result");

    const appliedFilters: Record<string, string> = {};
    if (effectiveBrand) appliedFilters.brand = effectiveBrand;
    if (query.modelSeries) appliedFilters.modelSeries = query.modelSeries;
    if (query.developmentCode) appliedFilters.developmentCode = query.developmentCode;
    if (query.filterByType) appliedFilters.filterByType = query.filterByType;
    const filters = Object.entries(result.availableFilters).map(([name, values]) => ({
      name,
      values: Array.isArray(values) ? values.flatMap(value => {
        if (typeof value === "string") return value ? [{ value, label: value }] : [];
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        const itemValue = record.searchTerm ?? record.value;
        if (typeof itemValue !== "string" || !itemValue) return [];
        const label = record.displayTerm ?? record.label ?? record.searchTerm;
        return [{ value: itemValue, label: typeof label === "string" ? label : itemValue }];
      }) : [],
    }));
    const models = result.typekeys.flatMap(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const typekey = record.typekey ?? record.typeCode;
      const family = query.developmentCode ?? record.developmentCode ?? record.family ?? record.baseType;
      if (typeof typekey !== "string" || !/^[A-Z0-9]{4}$/.test(typekey) || typeof family !== "string" || !/^[A-Z0-9]+$/.test(family)) return [];
      const labelValue = record.displayTerm ?? record.model;
      const model = typeof record.model === "string" && record.model ? record.model : undefined;
      return [{
        id: typekey,
        label: typeof labelValue === "string" && labelValue ? labelValue : typekey,
        attributes: record,
        selection: { ...(query.modelSeries ? { series: query.modelSeries } : {}), typekeys: [{ typekey, family, ...(model ? { model } : {}) }] },
      }];
    });
    return { manufacturer: query.manufacturer ?? query.brand ?? "BMW", appliedFilters, filters, models, complete: Boolean(query.filterByType), ...(query.includeRaw ? { raw: result.raw } : {}) };
  };
}
