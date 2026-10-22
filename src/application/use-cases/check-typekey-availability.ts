import { NotAvailableError } from "reader-core/domain/errors";
import type { CatalogCache } from "../ports/catalog-cache.js";
import { TYPEKEY_UNAVAILABLE_CODE, TypekeyUnavailableError } from "../../domain/labour/errors.js";
import { mapConcurrent } from "reader-core/shared/concurrency";

export type TypekeyAvailability = "available" | "unavailable" | "unknown";

export type TypekeyAvailabilityDependencies = {
  cache: CatalogCache;
  fetchCatalog(typekey: string, language: string): Promise<unknown>;
};

export async function checkTypekeyAvailability(typekey: string, language: string, dependencies: TypekeyAvailabilityDependencies): Promise<TypekeyAvailability> {
  const { cache } = dependencies;
  try {
    if (await cache.isUnavailable(typekey, language)) return "unavailable";
    if (await cache.getCatalog(typekey, language) !== undefined) return "available";
  } catch { /* the cache is an optimisation; fall through to BMW */ }
  try {
    const catalog = await dependencies.fetchCatalog(typekey, language);
    if (!Array.isArray(catalog) || catalog.length) await cache.setCatalog(typekey, language, catalog).catch(() => undefined);
    return "available";
  } catch (error) {
    if (error instanceof TypekeyUnavailableError) {
      await cache.markUnavailable(typekey, language).catch(() => undefined);
      return "unavailable";
    }
    return "unknown";
  }
}

export function unavailableTypekeysMessage(typekeys: string[]) {
  return typekeys.length === 1
    ? `Typekey ${typekeys[0]} no disponible en BMW Flat Rates (${TYPEKEY_UNAVAILABLE_CODE})`
    : `Typekeys ${typekeys.join(", ")} no disponibles en BMW Flat Rates (${TYPEKEY_UNAVAILABLE_CODE})`;
}

export async function assertTypekeysAvailable(typekeys: string[], language: string, dependencies: TypekeyAvailabilityDependencies, concurrency = 3) {
  const unique = [...new Set(typekeys)];
  const results = await mapConcurrent(unique, concurrency, async typekey => ({ typekey, status: await checkTypekeyAvailability(typekey, language, dependencies) }));
  const unavailable = results.filter(item => item.status === "unavailable").map(item => item.typekey);
  if (unavailable.length) {
    throw new NotAvailableError(unavailableTypekeysMessage(unavailable), { typekeys: unavailable.map(typekey => ({ typekey, code: TYPEKEY_UNAVAILABLE_CODE })) });
  }
}
