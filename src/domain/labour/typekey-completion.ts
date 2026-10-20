export type TypekeyCompletedRequest = { requestId: string; axCode: string | null; edition: string | null; at: string; reused: boolean };

export type TypekeyCompletedMarker = {
  schemaVersion: 1;
  path: string;
  group: string;
  manufacturer: string;
  series: string;
  model: string;
  family: string;
  typekey: string;
  date: string;
  hgs: number;
  awSheetOIDs: number;
  inklusivPositionenFiles: number;
  umfasstTexteFiles: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  language: string;
  requestId: string;
  axCode: string | null;
  edition: string | null;
  requests: TypekeyCompletedRequest[];
};

export function addCompletedRequest(marker: TypekeyCompletedMarker, request: TypekeyCompletedRequest): TypekeyCompletedMarker {
  const requests = marker.requests ?? [];
  if (requests.some(existing => existing.requestId === request.requestId)) return marker;
  return { ...marker, requests: [...requests, request] };
}
