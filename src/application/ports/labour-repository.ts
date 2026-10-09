import type { JobState } from "../../types.js";
import type { LabourListFilters, LabourListItem } from "../../domain/labour/types.js";

export interface LabourRepository {
  get(id: string): Promise<JobState | null>;
  create(state: JobState): Promise<JobState>;
  patch(id: string, patch: Partial<JobState>, deletedKeys?: string[]): Promise<JobState | null>;
  list(filters?: LabourListFilters, cursor?: string, limit?: number): Promise<{ items: LabourListItem[]; nextCursor: string | null }>;
}
