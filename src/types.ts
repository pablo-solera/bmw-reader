export type { ExtractionInput, JobState, JobStatus } from "./domain/labour/job-state.js";

export type CatalogEntry = { id: string; number: string; text: string; entries?: CatalogEntry[] };
export type Flatrate = { awSheetOID?: string };
export type FlatrateGroup = {
  catalogPaths?: string[];
  containsValidityExpression?: boolean;
  flatrates?: Flatrate[];
  klammerText?: string;
  lackFlaeche?: number;
  lackStufe?: number;
  orderNumber?: string;
  rubrikText?: string;
  solrId?: string;
  sonderAw?: boolean;
  text?: string;
  valid?: boolean;
};
