import { createHash } from "node:crypto";
import { UpstreamError, ValidationError } from "reader-core/domain/errors";
import type { TypeResearchQuery } from "../bmw/type-research.js";

export type ModelOptionsDependencies = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", ttlSeconds: number): Promise<unknown>;
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
    if (cached) return JSON.parse(cached) as unknown;
    try {
      const result = await dependencies.discover({ ...query, brand: effectiveBrand });
      const appliedFilters: Record<string, string> = {};
      if (effectiveBrand) appliedFilters.brand = effectiveBrand;
      if (query.modelSeries) appliedFilters.modelSeries = query.modelSeries;
      if (query.developmentCode) appliedFilters.developmentCode = query.developmentCode;
      if (query.filterByType) appliedFilters.filterByType = query.filterByType;
      const filters = Object.entries(result.availableFilters).map(([name, values]) => ({
        name,
        values: Array.isArray(values) ? values.map(value => typeof value === "string" ? { value, label: value } : {
          value: String((value as Record<string, unknown>).searchTerm ?? (value as Record<string, unknown>).value ?? ""),
          label: String((value as Record<string, unknown>).displayTerm ?? (value as Record<string, unknown>).label ?? (value as Record<string, unknown>).searchTerm ?? ""),
        }).filter(item => item.value) : [],
      }));
      const models = result.typekeys.flatMap(value => {
        if (!value || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        const typekey = String(record.typekey ?? record.typeCode ?? "");
        const family = String(record.family ?? record.developmentCode ?? record.baseType ?? query.developmentCode ?? "");
        return typekey ? [{ id: typekey, label: String(record.displayTerm ?? record.model ?? typekey), attributes: record, selection: { ...(query.modelSeries ? { series: query.modelSeries } : {}), typekeys: [{ typekey, family, ...(record.model ? { model: String(record.model) } : {}) }] } }] : [];
      });
      const response = { manufacturer: query.manufacturer ?? query.brand ?? "BMW", appliedFilters, filters, models, complete: Boolean(query.filterByType), ...(query.includeRaw ? { raw: result.raw } : {}) };
      await dependencies.set(cacheKey, JSON.stringify(response), "EX", 86400);
      return response;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new UpstreamError("BMW Vehicle Type Research request failed", undefined, { cause: error });
    }
  };
}
