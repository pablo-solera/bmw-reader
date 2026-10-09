export type ExtractionInput = {
  manufacturer: string;
  series?: string;
  model?: string;
  family: string;
  axCode?: string;
  edition: string;
  date?: string;
  language?: string;
};

export type JobStatus = "queued" | "downloading" | "rate-limited" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";
export type JobState = {
  requestId: string;
  status: JobStatus;
  stage: string;
  progress: number | null;
  bullJobId?: string;
  typekeyPaths?: string[];
  input?: ExtractionInput;
  extractionSummary?: { typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>; date: string; axCode?: string | null };
  rateLimitInfo?: { count: number; cooldownUntil: string; retryAfterMs?: number };
  resource?: "labours";
  error?: string;
  createdAt: string;
  updatedAt: string;
};

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
