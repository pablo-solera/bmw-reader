import type { Redis } from "ioredis";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import type { CatalogCache } from "../../application/ports/catalog-cache.js";

const CATALOG_TTL_SECONDS = 60 * 60;
const UNAVAILABLE_TTL_SECONDS = 24 * 60 * 60;

export function createRedisCatalogCache(redis: Pick<Redis, "get" | "set">): CatalogCache {
  const key = createKeyspace("bmw-reader");
  const catalogKey = (typekey: string, language: string) => key("catalog", language, typekey);
  const unavailableKey = (typekey: string, language: string) => key("catalog-unavailable", language, typekey);
  return {
    async getCatalog(typekey, language) {
      const value = await redis.get(catalogKey(typekey, language));
      return value === null ? undefined : JSON.parse(value) as unknown;
    },
    async setCatalog(typekey, language, catalog) {
      await redis.set(catalogKey(typekey, language), JSON.stringify(catalog), "EX", CATALOG_TTL_SECONDS);
    },
    async isUnavailable(typekey, language) {
      return await redis.get(unavailableKey(typekey, language)) !== null;
    },
    async markUnavailable(typekey, language) {
      await redis.set(unavailableKey(typekey, language), "1", "EX", UNAVAILABLE_TTL_SECONDS);
    },
  };
}
