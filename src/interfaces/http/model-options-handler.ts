import { z } from "zod";
import { createModelOptionsUseCase } from "../../application/use-cases/get-model-options.js";
import type { TypeResearchQuery } from "../../application/ports/vehicle-type-research.js";
import { modelOptionsSchema } from "reader-core/contract/v1";

function isValidCachedSource(value: unknown): value is { availableFilters: Record<string, unknown>; typekeys: unknown[]; raw: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !!record.availableFilters && typeof record.availableFilters === "object" && !Array.isArray(record.availableFilters)
    && Array.isArray(record.typekeys) && "raw" in record;
}

export function createParsedModelOptionsHandler(
  discover: (query: TypeResearchQuery) => Promise<{ availableFilters: Record<string, unknown>; typekeys: unknown[]; raw: unknown }>,
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string, expiry: "EX", ttlSeconds: number) => Promise<unknown>,
) {
  const useCase = createModelOptionsUseCase({
    get,
    set: (key, value, ttlSeconds) => set(key, value, "EX", ttlSeconds),
    discover,
    isValidCachedSource,
  });
  return async (queryValue: Record<string, unknown>) => {
    const query = z.object({
      manufacturer: z.enum(["BMW", "MINI"]).optional(),
      language: z.string().min(1).default("en-GB"),
      includeRaw: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
      brand: z.string().min(1).optional(),
      modelSeries: z.string().min(1).optional(),
      developmentCode: z.string().min(1).optional(),
      filterByType: z.string().min(1).optional(),
    }).parse(queryValue);
    return modelOptionsSchema.parse(await useCase(query));
  };
}
