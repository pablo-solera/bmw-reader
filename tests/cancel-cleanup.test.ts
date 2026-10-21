import { describe, expect, test } from "bun:test";
import { cleanupCancelledLabourUseCase } from "../src/application/use-cases/cleanup-cancelled-labour.js";
import { typekeyPathForJob } from "../src/application/typekey-path.js";
import type { LabourInput } from "../src/domain/labour/types.js";

const input: LabourInput = {
  manufacturer: "BMW",
  series: "7",
  date: "20261009",
  typekeys: [
    { typekey: "11EH", family: "G70" },
    { typekey: "21EH", family: "G70" },
    { typekey: "31EH", family: "G70" },
  ],
};

describe("cancelled labour cleanup use case", () => {
  test("preserves completed and unowned paths and clears only owned incomplete data", async () => {
    const completedPath = typekeyPathForJob(input, 0)!;
    const ownedPath = typekeyPathForJob(input, 1)!;
    const unownedPath = typekeyPathForJob(input, 2)!;
    const calls: string[] = [];
    const result = await cleanupCancelledLabourUseCase("request-1", input, {
      hasCompletionMarker: async path => path === completedPath,
      getOwnedLockHashes: async () => new Set([ownedPath]),
      isOwnedPath: (path, owned) => owned.has(path),
      deletePrefix: async path => { calls.push(`delete:${path}`); return 2; },
      clearProgress: async path => { calls.push(`clear:${path}`); },
      releasePaths: async (_id, paths) => { calls.push(`release:${paths.join(",")}`); },
      recordIncompleteFailure: async path => { calls.push(`failure:${path}`); },
      warn: () => undefined,
    });

    expect(calls).toContain(`delete:${ownedPath}`);
    expect(calls).toContain(`clear:${ownedPath}`);
    expect(calls).not.toContain(`failure:${unownedPath}`);
    expect(calls).toContain(`release:${ownedPath},${unownedPath}`);
    expect(calls).not.toContain(`delete:${completedPath}`);
    expect(calls).not.toContain(`delete:${unownedPath}`);
    expect(result).toEqual([
      { typekey: "21EH", deletedObjects: 2, skipped: false },
      { typekey: "31EH", deletedObjects: 0, skipped: true },
      { typekey: "11EH", deletedObjects: 0, skipped: true },
    ]);
  });

  test("releases cleanup claims and records failed work when deletion fails", async () => {
    const ownedPath = typekeyPathForJob(input, 1)!;
    const failedPaths: string[] = [];
    let released: string[] = [];
    await expect(cleanupCancelledLabourUseCase("request-2", input, {
      hasCompletionMarker: async () => false,
      getOwnedLockHashes: async () => new Set([ownedPath]),
      isOwnedPath: path => path === ownedPath,
      deletePrefix: async () => { throw new Error("S3 unavailable"); },
      clearProgress: async () => undefined,
      releasePaths: async (_id, paths) => { released = paths; },
      recordIncompleteFailure: async path => { failedPaths.push(path); },
      warn: () => undefined,
    })).rejects.toThrow("S3 unavailable");
    expect(released).toContain(ownedPath);
    expect(failedPaths).toEqual([ownedPath]);
  });
});
