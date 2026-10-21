import { ConflictError, NotFoundError, NotReadyError } from "reader-core/domain/errors";
import type { LabourState } from "../../domain/labour/labour-state.js";
import { typekeyArtifacts } from "./fetch-typekey.js";

export type DownloadLabourArtifactDependencies = {
  getState(requestId: string): Promise<LabourState | null>;
  getArtifact(key: string): Promise<unknown | undefined>;
  signDownload(key: string): Promise<string>;
  objectKey(...parts: string[]): string;
  bucket: string;
};

export async function downloadLabourArtifactUseCase(
  requestId: string,
  artifactName: string | undefined,
  dependencies: DownloadLabourArtifactDependencies,
) {
  const state = await dependencies.getState(requestId);
  if (!state) throw new NotFoundError("Labour request not found", { requestId });
  const summary = state.typekeySummary;
  const artifacts = state.input && summary
    ? typekeyArtifacts({ ...state.input, date: summary.date }, summary.typekeys, dependencies.objectKey, dependencies.bucket)
    : [];
  if (!artifactName) throw new NotReadyError("BMW labour requests do not have a single primary file", { artifacts });
  const artifact = artifacts.find(item => item.name === artifactName);
  if (!artifact) throw new NotFoundError("Artifact not found", { requestId, artifact: artifactName });
  if (artifact.kind === "prefix") throw new ConflictError("S3 prefixes cannot be downloaded as a single file", { artifact: artifact.name });
  const markerReady = artifact.name.endsWith("_completed.json") && await dependencies.getArtifact(artifact.location.key) !== undefined;
  if (state.status !== "completed" && !markerReady) throw new NotReadyError("Artifact is not ready", { status: state.status, artifact: artifact.name });
  return dependencies.signDownload(artifact.location.key);
}
