import type { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import { createRedisCatalogCache } from "../infrastructure/redis/catalog-cache.js";
import type { BmwClient, BmwClientOverrides } from "../infrastructure/bmw/client.js";
import { assertTypekeysAvailable, checkTypekeyAvailability } from "../application/use-cases/check-typekey-availability.js";

const AVAILABILITY_CHECK_TIMEOUT_MS = 15_000;

export type TypekeyAvailabilityDependencies = {
  redis: Pick<Redis, "get" | "set">;
  settings: Pick<AppConfig, "BMW_API_LANGUAGE" | "BMW_MODEL_OPTIONS_RATE_LIMIT_WAIT_MS">;
  createBmwClient(overrides?: BmwClientOverrides): BmwClient;
};

export function createTypekeyAvailability({ redis, settings, createBmwClient }: TypekeyAvailabilityDependencies) {
  const cache = createRedisCatalogCache(redis);
  const dependencies = {
    cache,
    fetchCatalog: (typekey: string, language: string) => createBmwClient({ language, cancelSignal: AbortSignal.timeout(AVAILABILITY_CHECK_TIMEOUT_MS) })
      .catalogInteractive(typekey, settings.BMW_MODEL_OPTIONS_RATE_LIMIT_WAIT_MS),
  };
  return {
    cache,
    check: (typekey: string, language?: string) => checkTypekeyAvailability(typekey, language ?? settings.BMW_API_LANGUAGE, dependencies),
    assertAvailable: (typekeys: string[], language?: string) => assertTypekeysAvailable(typekeys, language ?? settings.BMW_API_LANGUAGE, dependencies),
  };
}

export type TypekeyAvailabilityService = ReturnType<typeof createTypekeyAvailability>;
