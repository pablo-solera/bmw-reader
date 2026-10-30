import type { LabourState } from "../../domain/labour/labour-state.js";
import type { LabourListFilters, LabourListItem } from "../../domain/labour/types.js";
import type { EnqueueLabourRequest } from "../../application/use-cases/enqueue-labour.js";
import type { TypekeyAvailabilityReport } from "../../application/use-cases/get-typekey-availability.js";
import type { ModelOptions, RequestState } from "@solera/core-reader/contract/v1";

export type AppDependencies = {
  readyChecks: Record<string, () => Promise<void>>;
  openApi: unknown;
  docsHtml: string;
  modelOptions(query: Record<string, unknown>): Promise<ModelOptions>;
  typekeyAvailability(query: Record<string, unknown>): Promise<TypekeyAvailabilityReport>;
  createLabour(input: EnqueueLabourRequest, resumeAt?: number, requestId?: string): Promise<string>;
  listLabours(filters: LabourListFilters, cursor?: string, limit?: number): Promise<{ items: LabourListItem[]; nextCursor: string | null }>;
  getState(requestId: string): Promise<LabourState | null>;
  cancelLabour(requestId: string): Promise<{ requestId: string; status: string }>;
  resumeLabour(requestId: string, force: boolean): Promise<unknown>;
  isLabourStalled(requestId: string, currentState?: LabourState): Promise<boolean>;
  downloadArtifact(requestId: string, name?: string): Promise<string>;
  createLabourArchive(requestId: string): Promise<{ stream: NodeJS.ReadableStream; start(): void }>;
  mapState(value: LabourState): Promise<RequestState>;
};
