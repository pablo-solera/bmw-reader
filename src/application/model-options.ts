import { createHash } from "node:crypto";
import { UnavailableError, UpstreamError, ValidationError } from "reader-core/domain/errors";
import type { TypeResearchQuery } from "../bmw/type-research.js";

export type ModelOptionsDependencies = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  isValidCachedResult(value: unknown): boolean;
  discover(query: TypeResearchQuery): Promise<{ availableFilters: Record<string, unknown>; typekeys: unknown[]; raw: unknown }>;
};

export function createModelOptionsUseCase(dependencies: ModelOptionsDependencies) {
  return async function getModelOptions(query: TypeResearchQuery & { manufacturer?: string; includeRaw?: boolean }) {
    const effectiveBrand = query.filterByType ? query.brand : query.brand ?? query.manufacturer;
    if (query.filterByType && (effectiveBrand || query.modelSeries || query.developmentCode)) {
      throw new ValidationError("filterByType cannot be combined with brand, modelSeries or developmentCode");
    }
    const cacheQuery = { ...query, brand: effectiveBrand };
    const cacheKey = `bmw-reader:vehicle-options:${createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(cacheQuery).sort(([left], [right]) => left.localeCompare(right))))).digest("hex")}`;
    const cached = await dependencies.get(cacheKey);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (dependencies.isValidCachedResult(parsed)) return parsed;
      } catch {
        // Ignore corrupt or obsolete cache entries and refresh them from BMW.
      }
    }
    let result: Awaited<ReturnType<ModelOptionsDependencies["discover"]>>;
    try {
      result = await dependencies.discover({ ...query, brand: effectiveBrand });
    } catch (error) {
      if (error instanceof ValidationError || error instanceof UnavailableError) throw error;
      throw new UpstreamError("BMW Vehicle Type Research request failed", undefined, { cause: error });
    }

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
      const family = record.family ?? record.developmentCode ?? record.baseType ?? query.developmentCode;
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
    const response = { manufacturer: query.manufacturer ?? query.brand ?? "BMW", appliedFilters, filters, models, complete: Boolean(query.filterByType), ...(query.includeRaw ? { raw: result.raw } : {}) };
    await dependencies.set(cacheKey, JSON.stringify(response), 86400);
    return response;
  };
}
