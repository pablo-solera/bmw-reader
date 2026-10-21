import { describe, expect, it } from "bun:test";
import { recoverCancelledLabourJobs, resumeOrphanedLabourJobs } from "../src/application/use-cases/recover-labour-jobs.js";
import type { LabourState } from "../src/domain/labour/labour-state.js";
import { listLaboursUseCase } from "../src/application/use-cases/list-labours.js";

function jobState(requestId: string, status: string, queueJobId?: string): LabourState {
  return {
    requestId,
        status,
    stage: status,
    progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(queueJobId ? { queueJobId } : {}),
  } as LabourState;
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
      getStates: async ids => ids.map(id => states.get(id) ?? null),
      getQueueLabourState: async state => state.queueJobId ? "active" : null,
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
      getStates: async ids => ids.map(id => jobState(id, "paused")),
      getQueueLabourState: async () => null,
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
      getStates: async ids => ids.map(id => states.get(id) ?? null),
      getQueueLabourState: async state => state.queueJobId === "active-job" ? "active" : "pending",
      finalizeCancellation: async id => { finalized.push(id); },
    });

    expect(recovered).toBe(2);
    expect(finalized).toEqual(["orphan", "waiting"]);
  });
});

describe("labour listing cursor", () => {
  it("keeps keyset pagination stable when new requests arrive between pages", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const states = new Map<string, LabourState>([
      ["a", listedState("a", timestamp)],
      ["b", listedState("b", timestamp)],
      ["c", listedState("c", timestamp)],
      ["d", listedState("d", "2025-12-31T23:59:59.000Z")],
    ]);
    const fetchPage = async (after: { score: number; requestId: string } | null, offset: number, limit: number) => {
      let ids = [...states.keys()].sort((left, right) => {
        const score = Date.parse(states.get(right)!.createdAt) - Date.parse(states.get(left)!.createdAt);
        return score || right.localeCompare(left);
      });
      if (after) ids = ids.filter(id => {
        const score = Date.parse(states.get(id)!.createdAt);
        return score < after.score || (score === after.score && id < after.requestId);
      });
      else ids = ids.slice(offset);
      return ids.slice(0, limit);
    };
    const dependencies = {
      ensureIndex: async () => undefined,
      cutoff: () => 0,
      pruneExpired: async () => undefined,
      fetchRequestIds: async (_cutoff: number, after: { score: number; requestId: string } | null, limit: number) => fetchPage(after, 0, limit),
      fetchStates: async (ids: string[]) => ids.map(id => states.get(id) ?? null),
      removeMissing: async () => undefined,
    };

    const first = await listLaboursUseCase({}, undefined, 2, dependencies);
    expect(first.items.map(item => item.requestId)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeTruthy();
    states.set("z", listedState("z", "2026-01-01T00:00:01.000Z"));

    const second = await listLaboursUseCase({}, first.nextCursor ?? undefined, 2, dependencies);
    expect(second.items.map(item => item.requestId)).toEqual(["a", "d"]);
    expect(second.nextCursor).toBeNull();
  });
});

function listedState(requestId: string, createdAt: string): LabourState {
  return {
    ...jobState(requestId, "completed"),
    createdAt,
    updatedAt: createdAt,
    input: { manufacturer: "BMW", family: "G70", edition: "20260101", date: "20260101" },
    typekeySummary: {
      date: "20260101",
      typekeys: [{ typekey: "11EH", family: "G70", hgs: 1, awSheetOIDs: 1, completedAwSheetOIDs: 1, remainingAwSheetOIDs: 0 }],
    },
  };
}
