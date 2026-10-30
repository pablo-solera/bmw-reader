import { describe, expect, test } from "bun:test";
import { ConflictError, NotFoundError, NotReadyError } from "@solera/core-reader/domain/errors";
import { downloadLabourArtifactUseCase } from "../src/application/use-cases/download-labour-artifact.js";
import type { LabourState } from "../src/domain/labour/labour-state.js";

const state: LabourState = {
  requestId: "00000000-0000-4000-8000-000000000001",
    status: "running",
  stage: "11EH:aw-sheet-details",
  progress: 50,
  input: { manufacturer: "BMW", series: "7", model: "740i", family: "G70", edition: "05_0", date: "20261009" },
  typekeySummary: {
    date: "20261009",
    typekeys: [{ typekey: "11EH", series: "7", family: "G70", hgs: 2, awSheetOIDs: 10, completedAwSheetOIDs: 5, remainingAwSheetOIDs: 5 }],
  },
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:10:00.000Z",
};

function dependencies(overrides: Partial<{
  state: LabourState | null;
  marker: unknown | undefined;
  signedKey: string;
}> = {}) {
  const calls: string[] = [];
  return {
    calls,
    useCase: (requestId: string, name?: string) => downloadLabourArtifactUseCase(requestId, name, {
      getState: async () => overrides.state === undefined ? state : overrides.state,
      getArtifact: async key => { calls.push(`get:${key}`); return overrides.marker; },
      signDownload: async key => { calls.push(`sign:${key}`); return overrides.signedKey ?? "https://download.test/signed"; },
      objectKey: (...parts: string[]) => parts.join("/"),
      bucket: "test-bucket",
    }),
  };
}

describe("download labour artifact use case", () => {
  test("rejects missing, unknown and prefix artifacts with typed errors", async () => {
    const fixture = dependencies();
    await expect(fixture.useCase(state.requestId)).rejects.toBeInstanceOf(NotReadyError);
    await expect(fixture.useCase(state.requestId, "unknown.json")).rejects.toBeInstanceOf(NotFoundError);
    await expect(fixture.useCase(state.requestId, "11EH")).rejects.toBeInstanceOf(ConflictError);
    expect(fixture.calls).toEqual([]);
  });

  test("allows a completion-marker download early only when the marker exists", async () => {
    const key = "BMW/BMW/labour/7/G70/20261009/11EH/11EH_completed.json";
    const missing = dependencies();
    await expect(missing.useCase(state.requestId, "11EH_completed.json")).rejects.toBeInstanceOf(NotReadyError);
    expect(missing.calls).toEqual([`get:${key}`]);

    const ready = dependencies({ marker: { complete: true }, signedKey: "https://download.test/marker" });
    expect(await ready.useCase(state.requestId, "11EH_completed.json")).toBe("https://download.test/marker");
    expect(ready.calls).toEqual([`get:${key}`, `sign:${key}`]);
  });

  test("rejects missing requests and downloads ordinary files after completion", async () => {
    await expect(dependencies({ state: null }).useCase(state.requestId, "11EH_completed.json")).rejects.toBeInstanceOf(NotFoundError);
    const completed = dependencies({ state: { ...state, status: "completed" } });
    expect(await completed.useCase(state.requestId, "11EH_completed.json")).toBe("https://download.test/signed");
  });
});
