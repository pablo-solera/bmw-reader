import type { JobState } from "./job-state.js";

export type LabourInput = { axCode?: string; edition?: string; manufacturer: string; series?: string; model?: string; date: string; typekeys: Array<{ typekey: string; series?: string; family: string; model?: string }>; language?: string };
export type LabourListFilters = { status?: string[]; axCode?: string; edition?: string; manufacturer?: string };
export type LabourListItem = {
  requestId: string;
  manufacturer: string;
  status: JobState["status"];
  stage: string;
  progress: number | null;
  axCode: string | null;
  edition: string;
  date: string;
  typekeys: Array<{ typekey: string; series?: string; family: string; model?: string; hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
