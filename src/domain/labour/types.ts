import type { LabourState } from "./labour-state.js";
import type { LabourInput, LabourTypekeyInput } from "./input.js";
export type { LabourInput, LabourInputBase, LabourTypekeyInput } from "./input.js";

export type LabourListFilters = { status?: string[]; axCode?: string; edition?: string; manufacturer?: string };
export type LabourListItem = {
  requestId: string;
  manufacturer: string;
  status: LabourState["status"];
  stage: string;
  progress: number | null;
  axCode: string | null;
  edition: string;
  date: string;
  typekeys: Array<LabourTypekeyInput & { hgs: number; awSheetOIDs: number; completedAwSheetOIDs: number; remainingAwSheetOIDs: number; failedOids?: number }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
