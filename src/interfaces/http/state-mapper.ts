import type { Artifact, CreateRequest, RequestState, RequestSummary } from "@pablosla/core-reader/contract/v1";
import type { LabourState } from "../../domain/labour/labour-state.js";
import { typekeyArtifacts } from "../../application/use-cases/fetch-typekey.js";

export function bmwRequestFrom(value: LabourState): CreateRequest {
  const input = value.input;
  const summary = value.typekeySummary;
  return {
    manufacturer: input?.manufacturer ?? "BMW",
    ...(input?.axCode ? { axCode: input.axCode } : {}),
    ...(input?.edition ? { edition: input.edition } : {}),
    ...(input?.language ? { language: input.language } : {}),
    selection: {
      ...(input?.series ? { series: input.series } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(summary?.date ? { date: summary.date } : {}),
      typekeys: (summary?.typekeys ?? []).map(item => ({ typekey: item.typekey, series: item.series, family: item.family, ...(item.model ? { model: item.model } : {}) })),
    },
  };
}

export function toBmwRequestState(value: LabourState, objectKey: (...parts: string[]) => string, bucket: string, operations: { worker: unknown; stalled: boolean }): RequestState {
  const input = value.input;
  const summary = value.typekeySummary;
  const artifacts: Artifact[] = input && summary ? typekeyArtifacts({ ...input, date: summary.date }, summary.typekeys, objectKey, bucket) : [];
  return {
    requestId: value.requestId,
    resource: "labours",
    reader: "bmw",
    status: value.status,
    stage: value.stage,
    progress: value.progress,
    request: bmwRequestFrom(value),
    artifacts,
    error: value.error ? { code: "INTERNAL_ERROR", message: value.error } : null,
    details: { typekeys: summary?.typekeys ?? [], worker: operations.worker, stalled: operations.stalled, rateLimitInfo: value.rateLimitInfo ?? null },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.status === "completed" ? value.updatedAt : null,
  };
}

export function toBmwRequestSummary(item: { requestId: string; manufacturer: string; axCode?: string | null; edition: string; date: string; typekeys: Array<{ typekey: string; series?: string; family: string; model?: string }>; status: LabourState["status"]; stage: string; progress: number | null; error?: string | null; createdAt: string; updatedAt: string }): RequestSummary {
  return {
    requestId: item.requestId,
    resource: "labours",
    reader: "bmw",
    status: item.status,
    stage: item.stage,
    progress: item.progress,
    request: { manufacturer: item.manufacturer, ...(item.axCode ? { axCode: item.axCode } : {}), edition: item.edition, selection: { date: item.date, typekeys: item.typekeys.map(key => ({ typekey: key.typekey, ...(key.series ? { series: key.series } : {}), family: key.family, model: key.model })) } },
    error: item.error ? { code: "INTERNAL_ERROR", message: item.error } : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.status === "completed" ? item.updatedAt : null,
    artifactCount: item.typekeys.length * 2,
  };
}
