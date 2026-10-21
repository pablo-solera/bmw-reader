export type TypekeyProgressMeta = {
  path: string;
  startedAt: string;
  requestId: string;
  axCode: string | null;
  edition: string | null;
  language: string;
  inklusivPositionenFiles: number;
  umfasstTexteFiles: number;
};

export type TypekeyCancellationMarker = { cancelledByRequestId: string; message: string };

export interface TypekeyProgressStore {
  initialize(path: string, request: { requestId: string; axCode?: string; edition?: string; language: string; forceRestart?: boolean }): Promise<TypekeyProgressMeta>;
  metadata(path: string): Promise<TypekeyProgressMeta>;
  completed(path: string): Promise<string[]>;
  failures(path: string): Promise<Record<string, string>>;
  cancellationMarker(path: string): Promise<TypekeyCancellationMarker | null>;
  recordCompleted(path: string, oid: string, inclusiveFiles: number, umfasstFiles: number): Promise<boolean>;
  recordFailed(path: string, oid: string, message: string): Promise<void>;
  recordIncompleteFailure(path: string, requestId: string, message: string): Promise<void>;
  clear(path: string): Promise<void>;
}
