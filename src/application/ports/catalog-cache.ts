export interface CatalogCache {
  getCatalog(typekey: string, language: string): Promise<unknown | undefined>;
  setCatalog(typekey: string, language: string, catalog: unknown): Promise<void>;
  isUnavailable(typekey: string, language: string): Promise<boolean>;
  markUnavailable(typekey: string, language: string): Promise<void>;
}
