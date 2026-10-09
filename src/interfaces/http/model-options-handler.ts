import { z } from "zod";
import { createModelOptionsUseCase } from "../../application/model-options.js";
import type { TypeResearchQuery } from "../../bmw/type-research.js";
import { modelOptionsSchema } from "reader-core/contract/v1";

export function createParsedModelOptionsHandler(
  discover: (query: TypeResearchQuery) => Promise<{ availableFilters: Record<string, unknown>; typekeys: unknown[]; raw: unknown }>,
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string, expiry: "EX", ttlSeconds: number) => Promise<unknown>,
) {
  const useCase = createModelOptionsUseCase({ get, set, discover });
  return async (queryValue: Record<string, unknown>) => {
    const query = z.object({
      manufacturer: z.string().min(1).optional(),
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
