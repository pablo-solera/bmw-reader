import { describe, expect, it } from "bun:test";
import { processLabourTypekeyUseCase, type ProcessLabourTypekeyDependencies, type TypekeyDownloadResult } from "../src/application/use-cases/process-labour-typekey.js";
import type { LabourInput } from "../src/domain/labour/types.js";
import type { LabourState } from "../src/domain/labour/labour-state.js";

const input: LabourInput = { manufacturer: "BMW", series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }, { typekey: "12EH", family: "G70" }] };
const state: LabourState = {
  requestId: "request-id", status: "running", stage: "downloading", progress: 0, queueJobId: "current-job",
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
  typekeySummary: { date: input.date, typekeys: input.typekeys.map(entry => ({ ...entry, hgs: 0, awSheetOIDs: 1, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 1 })) },
};

function dependencies(result: TypekeyDownloadResult, calls: string[], shuttingDown = false): ProcessLabourTypekeyDependencies {
  return {
    download: async (_input, _index, _id, _runId, _restart, onProgress) => {
      await onProgress({ stage: "aw-sheet-details", completed: 1, total: 2, hgs: 3 });
      return result;
    },
    state: {
      get: async () => state,
      update: async (_id, patch) => { calls.push(`state:${String(patch.status)}`); return { ...state, ...patch }; },
      finish: async () => { calls.push("finish"); return { kind: "extraction" }; },
    },
    cancellation: {
      finalize: async () => { calls.push("cancel"); },
      isRequested: async () => false,
      isCancelledError: () => false,
    },
    worker: { isShuttingDown: () => shuttingDown, addPaused: async () => { calls.push("paused"); }, now: () => 100 },
    typekeyLocks: { releaseCompletedPath: async () => { calls.push("release-completed"); }, releasePaths: async () => { calls.push("release-failed"); } },
    queue: { next: async (_id, _input, index, _runId, id) => { calls.push(`queue:${index}:${id}`); } },
    logger: { info: event => { calls.push(`info:${event}`); }, error: event => { calls.push(`error:${event}`); } },
    makeUnrecoverable: message => new Error(message),
  };
}

describe("process labour typekey use case", () => {
  it("persists progress and pauses cleanly during worker shutdown", async () => {
    const calls: string[] = [];
    const result = await processLabourTypekeyUseCase(
      { attemptsMade: 0, attempts: 2, id: "current-job" }, "request-id", input, 0, "run-id", false,
      dependencies({ paused: true, hgs: 3, awSheetOIDs: 2, completedAwSheetOIDs: 1, remainingAwSheetOIDs: 1 }, calls, true),
    );

    expect(result).toMatchObject({ kind: "paused", requestId: "request-id", typekey: "11EH" });
    expect(calls).toContain("state:paused");
    expect(calls).toContain("paused");
    expect(calls).not.toContain("release-completed");
  });

  it("releases a completed typekey then schedules the next index", async () => {
    const calls: string[] = [];
    const result = await processLabourTypekeyUseCase(
      { attemptsMade: 0, attempts: 2, id: "current-job" }, "request-id", input, 0, "run-id", false,
      dependencies({ hgs: 3, awSheetOIDs: 2, completedAwSheetOIDs: 2, remainingAwSheetOIDs: 0 }, calls),
    );

    expect(result).toEqual({ kind: "typekey", requestId: "request-id", typekey: "11EH", nextTypekey: "12EH" });
    expect(calls.indexOf("release-completed")).toBeLessThan(calls.findIndex(call => call.startsWith("queue:1:")));
    expect(calls).toContain("queue:1:request-id--run-id--1");
  });
});
