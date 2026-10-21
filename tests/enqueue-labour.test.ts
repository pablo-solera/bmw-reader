import { describe, expect, it } from "bun:test";
import { enqueueLabourUseCase, type EnqueueLabourDependencies } from "../src/application/use-cases/enqueue-labour.js";
import { cancelLabourUseCase } from "../src/application/use-cases/cancel-labour.js";
import { resumeLabourUseCase } from "../src/application/use-cases/resume-labour.js";
import type { JobState } from "../src/domain/labour/job-state.js";
import { EXTRACTION_JOB_OPTIONS } from "../src/infrastructure/bullmq/extraction-policy.js";

const input = { manufacturer: "BMW", series: "7'", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] };

function fixture(overrides: Partial<EnqueueLabourDependencies> = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  let current: JobState | null = null;
  const dependencies: EnqueueLabourDependencies = {
    getState: async () => current,
    saveState: async value => { current = value; calls.push({ kind: "save", value }); return value; },
    deleteState: async id => { calls.push({ kind: "delete", value: id }); },
    claimTypekeyPaths: async (_id, labour) => { calls.push({ kind: "claim", value: labour }); return ["BMW/BMW/labour/7/G70/20261009/11EH"]; },
    releaseTypekeyPaths: async (_id, paths) => { calls.push({ kind: "release", value: paths }); },
    isCancelling: async () => false,
    queue: {
      enqueue: async (data, jobId) => { calls.push({ kind: "queue", value: { data, jobId } }); return { id: jobId }; },
      getJob: async () => null,
    },
    newId: (() => { let id = 0; return () => `generated-${++id}`; })(),
    now: () => new Date("2026-10-09T12:00:00.000Z"),
    ...overrides,
  };
  return { dependencies, calls, setState: (value: JobState | null) => { current = value; } };
}

describe("enqueue labour use case", () => {
  it("validates and normalizes input, then persists state before enqueueing the established job", async () => {
    const { dependencies, calls } = fixture();
    const requestId = await enqueueLabourUseCase(input, dependencies, 0, "request-id");
    expect(requestId).toBe("request-id");
    expect(calls.map(call => call.kind)).toEqual(["claim", "save", "queue"]);
    const state = calls[1]!.value as JobState;
    expect(state).toMatchObject({ requestId, status: "queued", stage: "queued", createdAt: "2026-10-09T12:00:00.000Z", input: { series: "7" } });
    const queued = calls[2]!.value as { data: { runId: string; index: number }; jobId: string };
    expect(queued.data).toMatchObject({ requestId, index: 0 });
    expect(queued.jobId).toBe("request-id--generated-1--0");
    expect(EXTRACTION_JOB_OPTIONS).toMatchObject({ attempts: 2, backoff: { type: "exponential", delay: 30000 }, ignoreDependencyOnFailure: true });
  });

  it("defaults the extraction date in the application use case using its injected clock", async () => {
    const { date: _date, ...withoutDate } = input;
    const { dependencies, calls } = fixture();
    await enqueueLabourUseCase(withoutDate, dependencies, 0, "request-id");
    const state = calls[1]!.value as JobState;
    expect(state).toMatchObject({ input: { date: "20261009", edition: "20261009" }, extractionSummary: { date: "20261009" } });
  });

  it("releases claims and removes persisted state when queueing fails", async () => {
    const { dependencies, calls } = fixture({ queue: { enqueue: async () => { throw new Error("queue unavailable"); }, getJob: async () => null } });
    await expect(enqueueLabourUseCase(input, dependencies, 0, "request-id")).rejects.toThrow("queue unavailable");
    expect(calls.map(call => call.kind)).toEqual(["claim", "save", "delete", "release"]);
  });

  it("rejects duplicate request IDs and releases newly claimed paths", async () => {
    const { dependencies, calls, setState } = fixture();
    setState({ requestId: "request-id", resource: "labours", status: "queued", stage: "queued", progress: 0, createdAt: "now", updatedAt: "now" });
    await expect(enqueueLabourUseCase(input, dependencies, 0, "request-id")).rejects.toThrow("Request ID already exists with status queued");
    expect(calls).toEqual([]);
  });
});

describe("cancel labour use case", () => {
  it("marks a request cancelling and finalizes after removing a waiting job", async () => {
    const events: string[] = [];
    const current: JobState = { requestId: "request-id", resource: "labours", status: "queued", stage: "queued", progress: 0, bullJobId: "job-id", createdAt: "now", updatedAt: "now" };
    const result = await cancelLabourUseCase(current.requestId, {
      getState: async () => current,
      hasCancellation: async () => false,
      requestCancellation: async () => { events.push("flag"); },
      persistCancelling: async () => { events.push("persist"); },
      queue: { getJob: async () => ({ id: "job-id", getState: async () => "pending", remove: async () => { events.push("remove"); } }) },
      abortActive: () => undefined,
      finalize: async () => { events.push("finalize"); return { cleanup: [] }; },
      log: event => { events.push(event); },
    });

    expect(result).toMatchObject({ requestId: "request-id", status: "cancelled", cleanup: [] });
    expect(events).toEqual(["flag", "persist", "extraction_cancel_requested", "remove", "finalize"]);
  });

  it("leaves active jobs cancelling and rejects completed jobs", async () => {
    const current: JobState = { requestId: "request-id", resource: "labours", status: "downloading", stage: "downloading", progress: 10, bullJobId: "job-id", createdAt: "now", updatedAt: "now" };
    const result = await cancelLabourUseCase(current.requestId, {
      getState: async () => current,
      hasCancellation: async () => false,
      requestCancellation: async () => undefined,
      persistCancelling: async () => undefined,
      queue: { getJob: async () => ({ id: "job-id", getState: async () => "active", remove: async () => undefined }) },
      abortActive: () => undefined,
      finalize: async () => { throw new Error("must not finalize an active job"); },
      log: () => undefined,
    });
    expect(result).toEqual({ requestId: "request-id", status: "cancelling" });

    await expect(cancelLabourUseCase("completed", {
      getState: async () => ({ ...current, requestId: "completed", status: "completed" }),
      hasCancellation: async () => false,
      requestCancellation: async () => undefined,
      persistCancelling: async () => undefined,
      queue: { getJob: async () => null },
      abortActive: () => undefined,
      finalize: async () => ({ cleanup: [] }),
      log: () => undefined,
    })).rejects.toMatchObject({ message: "Completed labour requests cannot be cancelled", code: "CONFLICT" });
  });

  it("returns cancelling immediately while asynchronous storage cleanup is pending", async () => {
    const current: JobState = { requestId: "request-id", resource: "labours", status: "queued", stage: "queued", progress: 0, createdAt: "now", updatedAt: "now" };
    const result = await cancelLabourUseCase(current.requestId, {
      getState: async () => current,
      hasCancellation: async () => false,
      requestCancellation: async () => undefined,
      persistCancelling: async () => undefined,
      queue: { getJob: async () => null },
      abortActive: () => undefined,
      finalize: async () => ({ cleanup: [], pending: true }),
      log: () => undefined,
    });
    expect(result).toEqual({ requestId: "request-id", status: "cancelling" });
  });
});

describe("resume labour use case", () => {
  it("requeues a failed request with a new job ID", async () => {
    const current: JobState = {
      requestId: "request-id", resource: "labours", status: "failed", stage: "failed", progress: 20, bullJobId: "old-job", typekeyPaths: [],
      input: { manufacturer: "BMW", series: "7", family: "G70", edition: "20261009", language: "en-GB" },
      extractionSummary: { typekeys: [{ typekey: "11EH", series: "7", family: "G70", hgs: 0, awSheetOIDs: 0, completedAwSheetOIDs: 0, remainingAwSheetOIDs: 0 }], date: "20261009" },
      createdAt: "now", updatedAt: "now",
    };
    const updates: Array<Partial<JobState>> = [];
    let queued: { data: Record<string, unknown>; options: Record<string, unknown> } | undefined;
    const result = await resumeLabourUseCase("request-id", {
      getState: async () => current,
      updateState: async (_id, patch) => { updates.push(patch); return { ...current, ...patch }; },
      getHeartbeatTtl: async () => -1,
      workerIsActive: async () => false,
      workerShuttingDown: () => false,
      queue: {
        getJob: async id => id === "old-job" ? { id, getState: async () => "failed", remove: async () => undefined } : null,
        enqueue: async (data, jobId) => { queued = { data, options: { jobId } }; return { id: jobId }; },
      },
      queueName: "bmw-extractions",
      claimTypekeyPaths: async () => ["BMW/BMW/labour/7/G70/20261009/11EH"],
      releaseTypekeyPaths: async () => undefined,
      clearPaused: async () => undefined,
      newId: () => "new-run",
    });

    expect(result).toEqual({ requestId: "request-id", resumedAtTypekey: "11EH", queue: "bmw-extractions" });
    expect(updates[0]).toMatchObject({ status: "queued", bullJobId: "request-id--new-run--0" });
    expect(queued?.options).toEqual({ jobId: "request-id--new-run--0" });
  });

  it("refuses forced resume while a worker is active", async () => {
    const state: JobState = {
      requestId: "request-id", resource: "labours", status: "failed", stage: "failed", progress: 0,
      input: { manufacturer: "BMW", family: "G70", edition: "20261009" },
      extractionSummary: { typekeys: [], date: "20261009" }, createdAt: "now", updatedAt: "now",
    };
    await expect(resumeLabourUseCase("request-id", {
      getState: async () => state,
      updateState: async () => state,
      getHeartbeatTtl: async () => -1,
      workerIsActive: async () => true,
      workerShuttingDown: () => false,
      queue: { getJob: async () => null, enqueue: async (_data, jobId) => ({ id: jobId }) },
      queueName: "bmw-extractions",
      claimTypekeyPaths: async () => [],
      releaseTypekeyPaths: async () => undefined,
      clearPaused: async () => undefined,
      newId: () => "run",
    }, true)).rejects.toThrow("Force resume is disabled while a worker is active");
  });
});
