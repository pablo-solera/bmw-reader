import type { LabourInput } from "../../domain/labour/types.js";
import { incompleteTypekeysForCleanup, typekeyPathForJob } from "../typekey-path.js";

export type CleanupCancelledLabourDependencies = {
  hasCompletionMarker(path: string, typekey: string): Promise<boolean>;
  getOwnedLockHashes(requestId: string): Promise<Set<string>>;
  isOwnedPath(path: string, ownedHashes: Set<string>): boolean;
  deletePrefix(path: string): Promise<number>;
  clearProgress(path: string): Promise<void>;
  releasePaths(requestId: string, paths: string[]): Promise<void>;
  recordIncompleteFailure(path: string, message: string): Promise<void>;
  warn(event: string, details: Record<string, unknown>): void;
};

type CleanupResult = { typekey: string; deletedObjects: number; skipped: boolean };

export async function cleanupCancelledLabourUseCase(
  requestId: string,
  input: LabourInput,
  dependencies: CleanupCancelledLabourDependencies,
) {
  const completedPaths = new Set<string>();
  const markerResults = await Promise.all(input.typekeys.map(async (entry, index) => {
    const path = typekeyPathForJob(input, index);
    return path && await dependencies.hasCompletionMarker(path, entry.typekey) ? path : null;
  }));
  for (const path of markerResults) if (path) completedPaths.add(path);

  const ownedHashes = await dependencies.getOwnedLockHashes(requestId);
  const targets = incompleteTypekeysForCleanup(input, completedPaths, new Set());
  const results: Array<CleanupResult | undefined> = new Array(targets.length);
  const ownedTargets = new Set<number>();
  try {
    await Promise.all(targets.map(async ({ entry, path }, index) => {
      try {
        if (!dependencies.isOwnedPath(path, ownedHashes)) {
          results[index] = { typekey: entry.typekey, deletedObjects: 0, skipped: true };
          return;
        }
        if (await dependencies.hasCompletionMarker(path, entry.typekey)) {
          results[index] = { typekey: entry.typekey, deletedObjects: 0, skipped: true };
          return;
        }
        ownedTargets.add(index);
        const deletedObjects = await dependencies.deletePrefix(path);
        await dependencies.clearProgress(path);
        results[index] = { typekey: entry.typekey, deletedObjects, skipped: false };
      } catch (error) {
        dependencies.warn("typekey_cleanup_failed", {
          requestId,
          typekey: entry.typekey,
          path,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }));
  } finally {
    await dependencies.releasePaths(requestId, targets.map(target => target.path));
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      if (!ownedTargets.has(index) || results[index]) continue;
      await dependencies.recordIncompleteFailure(target.path, `Extraction ${requestId} was cancelled; create a new labour request to retry`);
    }
  }
  const deleted = results.filter((result): result is CleanupResult => result !== undefined);
  for (const entry of input.typekeys) {
    if (!deleted.some(result => result.typekey === entry.typekey)) deleted.push({ typekey: entry.typekey, deletedObjects: 0, skipped: true });
  }
  return deleted;
}
