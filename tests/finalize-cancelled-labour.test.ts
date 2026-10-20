import { describe, expect, test } from "bun:test";
import { finalizeCancelledLabourUseCase } from "../src/application/use-cases/finalize-cancelled-labour.js";
import type { JobState } from "../src/domain/labour/job-state.js";

const current: JobState = {
  requestId: "request-1",
  resource: "labours",
  status: "cancelling",
  stage: "cancelling",
  progress: 42,
  input: { manufacturer: "BMW", series: "7", family: "G70", edition: "05_0", date: "20261009", language: "en-GB" },
  extractionSummary: {
    date: "20261009",
    axCode: "A1",
    typekeys: [{ typekey: "11EH", series: "7", family: "G70", hgs: 1, awSheetOIDs: 2, completedAwSheetOIDs: 1, remainingAwSheetOIDs: 1 }],
  },
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:01:00.000Z",
};

describe("finalize cancelled labour use case", () => {
  test("builds cleanup input, records cancellation and clears both recovery indexes", async () => {
    const calls: string[] = [];
    const result = await finalizeCancelledLabourUseCase("request-1", current, {
      updateState: async (_id, patch) => { calls.push(`state:${patch.status}:${patch.progress}`); return null; },
      cleanup: async (_id, input) => { calls.push("cleanup"); expect(input).toMatchObject({ axCode: "A1", typekeys: [{ typekey: "11EH" }] }); return [{ typekey: "11EH", deletedObjects: 4, skipped: false }]; },
      clearPaused: async () => { calls.push("paused"); },
      clearCancellationState: async () => { calls.push("cancel-flags"); },
      log: event => { calls.push(event); },
    });
    expect(result).toEqual({ cleanup: [{ typekey: "11EH", deletedObjects: 4, skipped: false }], cleanupError: undefined });
    expect(calls).toEqual(["cleanup", "state:cancelled:42", "paused", "cancel-flags", "extraction_cancelled"]);
  });

  test("marks the request cancelled even when storage cleanup fails", async () => {
    let patch: Partial<JobState> | undefined;
    const result = await finalizeCancelledLabourUseCase("request-1", current, {
      updateState: async (_id, value) => { patch = value; return null; },
      cleanup: async () => { throw new Error("S3 unavailable"); },
      clearPaused: async () => undefined,
      clearCancellationState: async () => undefined,
      log: () => undefined,
    });
    expect(result.cleanupError).toBe("S3 unavailable");
    expect(patch).toMatchObject({ status: "cancelled", error: "Cancellation cleanup failed: S3 unavailable" });
  });
});
