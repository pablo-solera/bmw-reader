export type ExtractionInput = {
  dataRequestId?: string;
  manufacturer: string;
  model: string;
  family: string;
  axCode?: string;
  edition: string;
  typekeys: string[];
  group?: string;
  language?: string;
};

export type JobStatus = "queued" | "resolving" | "downloading" | "rate-limited" | "paused" | "extracting" | "loading" | "pivoting" | "reporting" | "completed" | "failed";
export type JobState = {
  requestId: string;
  status: JobStatus;
  stage: string;
  progress: number | null;
  input?: ExtractionInput;
  children?: Record<string, { requestId: string; status: string }>;
  reportKey?: string;
  extractionSummary?: { typekeys: Array<{ typekey: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>; date: string; axCode?: string | null };
  rateLimitInfo?: { count: number; cooldownUntil: string; retryAfterMs?: number };
  objectKey?: string;
  resource?: "labours" | "models" | "extractions";
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type JsonRecord = Record<string, unknown>;
export type CatalogEntry = { id: string; number: string; text: string; entries?: CatalogEntry[] };
export type Flatrate = {
  awSheetOID?: string;
  displayType?: string;
  hasInklusivPositionen?: boolean;
  hasUmfasstTexte?: boolean;
  klammerText?: string;
  lackFlaeche?: number;
  lackStufe?: number;
  lackwertMetallic?: number;
  lackwertUni?: number;
  number?: string;
  ruestwert?: number;
  sonderAw?: boolean;
  tcRelevant?: boolean;
  text?: string;
  validFrom?: string;
  validityExpression?: string;
  value?: number;
  workType?: string;
};
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

export type PivotRow = {
  typekeyCatalog_id: string;
  typekeyCatalog_number: string;
  typekeyCatalog_text: string;
  typekeyCatalog_entriesId: string;
  typekeyCatalog_entriesNumber: string;
  typekeyCatalog_entriesText: string;
  typekeyIdEntriesId_catalogPaths: string;
  typekeyIdEntriesId_rubrikText: string;
  typekeyIdEntriesId_text: string;
  typekeyIdEntriesId_flatrates_awSheetOID: string;
  typekeyIdEntriesId_flatrates_number: string;
  typekeyIdEntriesId_flatrates_text: string;
  typekeyIdEntriesId_flatrates_workType: string;
  typekeyIdEntriesId_flatrates_klammerText: string;
  orderNumber: string;
  values: Record<string, string>;
};
