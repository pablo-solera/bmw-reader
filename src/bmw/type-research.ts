import { createHash } from "node:crypto";
import { redis } from "../redis.js";
import { BmwClient } from "./client.js";

export type TypeResearchQuery = {
  brand?: string;
  modelSeries?: string;
  developmentCode?: string;
  filterByType?: string;
  language: string;
};

export function normalizeTypeResearchResponse(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { availableFilters: {}, typekeys: [], raw };
  const response = raw as Record<string, unknown>;
  return {
    availableFilters: response.availableFilters && typeof response.availableFilters === "object" ? response.availableFilters : {},
    typekeys: Array.isArray(response.typekeys) ? response.typekeys : [],
    queryParameters: response.queryParameters ?? null,
    raw,
  };
}

export async function getTypeResearchOptions(query: TypeResearchQuery) {
  if (query.filterByType && (query.brand || query.modelSeries || query.developmentCode)) {
    throw new Error("filterByType cannot be combined with brand, modelSeries or developmentCode");
  }
  const params: Record<string, string> = { language: query.language };
  if (query.filterByType) params.filterByType = query.filterByType;
  if (query.brand) params.filterByBrand = query.brand;
  if (query.modelSeries) params.filterByModelSeries = query.modelSeries;
  if (query.developmentCode) params.filterByDevelopmentCode = query.developmentCode;

  const key = `bmw-reader:vehicle-options:${createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))))).digest("hex")}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as ReturnType<typeof normalizeTypeResearchResponse>;
  const raw = await new BmwClient(query.language).vehicleAttributes(params);
  const result = normalizeTypeResearchResponse(raw);
  await redis.set(key, JSON.stringify(result), "EX", 86400);
  return result;
}
