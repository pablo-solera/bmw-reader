import type { JobState } from "../../types.js";
import type { LabourInput, LabourListFilters, LabourListItem } from "../../domain/labour/types.js";
import type { ModelOptions, RequestState } from "reader-core/contract/v1";

export type AppDependencies = {
  readyChecks: Record<string, () => Promise<void>>;
  openApi: unknown;
  docsHtml: string;
  modelOptions(query: Record<string, unknown>): Promise<ModelOptions>;
  createLabour(input: LabourInput, resumeAt?: number, requestId?: string): Promise<string>;
  listLabours(filters: LabourListFilters, cursor?: string, limit?: number): Promise<{ items: LabourListItem[]; nextCursor: string | null }>;
  getState(requestId: string): Promise<JobState | null>;
  cancelLabour(requestId: string): Promise<{ requestId: string; status: string }>;
  resumeLabour(requestId: string, force: boolean): Promise<unknown>;
  isLabourStalled(requestId: string, currentState?: JobState): Promise<boolean>;
  getArtifact(key: string): Promise<unknown | undefined>;
  signDownload(key: string): Promise<string>;
  mapState(value: JobState): Promise<RequestState>;
};
