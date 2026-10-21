/** BMW endpoints used to download labour source artifacts for a typekey. */
export interface BmwLabourApi {
  catalog(typekey: string): Promise<unknown>;
  flatRates(typekey: string, hg: string): Promise<unknown>;
  inklusivPositionen(typekey: string, awSheetOID: string): Promise<unknown>;
  umfasstTexte(typekey: string, awSheetOID: string): Promise<unknown>;
}
