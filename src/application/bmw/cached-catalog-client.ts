import type { BmwLabourApi } from "../ports/bmw-labour-api.js";
import type { CatalogCache } from "../ports/catalog-cache.js";

export function withCachedCatalog(client: BmwLabourApi, cache: Pick<CatalogCache, "getCatalog">, language: string): BmwLabourApi {
  return {
    catalog: async typekey => await cache.getCatalog(typekey, language).catch(() => undefined) ?? client.catalog(typekey),
    flatRates: (typekey, hg) => client.flatRates(typekey, hg),
    inklusivPositionen: (typekey, oid) => client.inklusivPositionen(typekey, oid),
    umfasstTexte: (typekey, oid) => client.umfasstTexte(typekey, oid),
  };
}
