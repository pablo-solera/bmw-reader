export interface BmwTypeResearchApi {
  catalog(typekey: string): Promise<unknown>;
  flatRates(typekey: string, hg: string): Promise<unknown>;
  inklusivPositionen(typekey: string, awSheetOID: string): Promise<unknown>;
  umfasstTexte(typekey: string, awSheetOID: string): Promise<unknown>;
}
