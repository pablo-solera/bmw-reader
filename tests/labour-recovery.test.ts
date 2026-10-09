import { describe, expect, it } from "bun:test";
import { recoverCancelledLabourJobs, resumeOrphanedLabourJobs } from "../src/application/use-cases/recover-labour-jobs.js";
import type { JobState } from "../src/types.js";

function jobState(requestId: string, status: string, bullJobId?: string): JobState {
  return {
    requestId,
    resource: "labours",
    status,
    stage: status,
    progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(bullJobId ? { bullJobId } : {}),
  } as JobState;
}

describe("labour recovery use cases", () => {
  it("resumes orphaned resumable requests once and leaves active queue jobs alone", async () => {
    const states = new Map([
      ["paused", jobState("paused", "paused")],
      ["queued", jobState("queued", "queued", "queued-job")],
      ["completed", jobState("completed", "completed")],
    ]);
    const resumes: string[] = [];
    const warnings: string[] = [];
    const resumed = await resumeOrphanedLabourJobs({
      getPausedRequestIds: async () => ["paused", "queued"],
      getIndexedRequestIds: async () => ["paused", "queued", "completed", "missing"],
      getState: async id => states.get(id) ?? null,
      getQueueJobState: async state => state.bullJobId ? "active" : null,
      resume: async id => { resumes.push(id); },
      warn: event => warnings.push(event),
    });

    expect(resumed).toBe(2);
    expect(resumes).toEqual(["paused"]);
    expect(warnings).toEqual([]);
  });

  it("continues after an individual resume failure and reports the skipped request", async () => {
    const warnings: string[] = [];
    const resumed = await resumeOrphanedLabourJobs({
      getPausedRequestIds: async () => ["broken", "healthy"],
      getIndexedRequestIds: async () => [],
      getState: async id => jobState(id, "paused"),
      getQueueJobState: async () => null,
      resume: async id => { if (id === "broken") throw new Error("queue unavailable"); },
      warn: (_event, id) => warnings.push(id),
    });

    expect(resumed).toBe(1);
    expect(warnings).toEqual(["broken"]);
  });

  it("finalizes cancelling requests except those with an active queue job", async () => {
    const states = new Map([
      ["active", jobState("active", "cancelling", "active-job")],
      ["orphan", jobState("orphan", "cancelling")],
      ["waiting", jobState("waiting", "cancelling", "waiting-job")],
      ["queued", jobState("queued", "queued")],
    ]);
    const finalized: string[] = [];
    const recovered = await recoverCancelledLabourJobs({
      getIndexedRequestIds: async () => [...states.keys()],
      getState: async id => states.get(id) ?? null,
      getQueueJobState: async state => state.bullJobId === "active-job" ? "active" : "waiting",
      finalizeCancellation: async id => { finalized.push(id); },
    });

    expect(recovered).toBe(2);
    expect(finalized).toEqual(["orphan", "waiting"]);
  });
});
