import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { buildBmwOpenApi, docsHtml } from "../src/interfaces/http/openapi.js";
import { createParsedModelOptionsHandler } from "../src/interfaces/http/model-options-handler.js";
import { ConflictError, NotFoundError, ValidationError } from "reader-core/domain/errors";
import type { AppDependencies } from "../src/interfaces/http/app-dependencies.js";
import { checkV1HttpConformance } from "reader-core/testing/conformance";

async function withServer(run: (baseUrl: string) => Promise<void>, modelOptions: AppDependencies["modelOptions"] = async () => ({ manufacturer: "BMW", appliedFilters: {}, filters: [], models: [], complete: false }), overrides: Partial<AppDependencies> = {}) {
  const fakeJob = { requestId: "00000000-0000-4000-8000-000000000001", status: "queued" as const };
  const app = createApp({
    readyChecks: { redis: async () => undefined },
    openApi: buildBmwOpenApi(3004),
    docsHtml,
    modelOptions,
    createLabour: async () => fakeJob.requestId,
    listLabours: async () => ({ items: [], nextCursor: null }),
    getState: async () => null,
    cancelLabour: async requestId => ({ requestId, status: "cancelled" as const }),
    resumeLabour: async () => ({}),
    isLabourStalled: async () => false,
    getArtifact: async () => undefined,
    signDownload: async () => "https://example.test/download",
    mapState: async () => null as never,
    ...overrides,
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe("BMW v1 HTTP contract", () => {
  test("exposes capabilities, readiness and only versioned business routes", async () => {
    await withServer(async baseUrl => {
      const info = await fetch(`${baseUrl}/v1/info`);
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({ reader: "bmw", contractVersion: "1.0.0", capabilities: { labours: { download: true }, parts: { create: false } } });
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/labours`)).status).toBe(404);
      expect(await (await fetch(`${baseUrl}/labours`)).json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
  });

  test("passes the reusable HTTP conformance checks", async () => {
    await withServer(async baseUrl => {
      expect(await checkV1HttpConformance(baseUrl)).toEqual([]);
    });
  });

  test("normalizes validation, unsupported and invalid-UUID errors", async () => {
    await withServer(async baseUrl => {
      const invalid = await fetch(`${baseUrl}/v1/labours`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manufacturer: "BMW", selection: {} }) });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: expect.any(String) } });
      const invalidId = await fetch(`${baseUrl}/v1/labours/not-a-uuid`);
      expect(invalidId.status).toBe(400);
      const unsupported = await fetch(`${baseUrl}/v1/parts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manufacturer: "BMW", selection: {} }) });
      expect(unsupported.status).toBe(501);
      expect(await unsupported.json()).toMatchObject({ error: { code: "NOT_SUPPORTED" } });
    });
  });

  test("returns typed validation, conflict and not-found errors with their contract status", async () => {
    const request = { manufacturer: "BMW", selection: { series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] } };
    await withServer(async baseUrl => {
      const badInput = await fetch(`${baseUrl}/v1/labours`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(badInput.status).toBe(400);
      expect(await badInput.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "axCode may only contain letters, digits and underscores" } });
    }, undefined, { createLabour: async () => { throw new ValidationError("axCode may only contain letters, digits and underscores"); } });

    await withServer(async baseUrl => {
      const conflict = await fetch(`${baseUrl}/v1/labours`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "CONFLICT" } });
      const missing = await fetch(`${baseUrl}/v1/labours/00000000-0000-4000-8000-000000000001/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }, undefined, {
      createLabour: async () => { throw new ConflictError("Extraction already has a queued or active job"); },
      resumeLabour: async () => { throw new NotFoundError("Resumable extraction not found"); },
    });
  });

  test("validates model-options query parameters and returns normalized discovery data", async () => {
    const discoverQueries: unknown[] = [];
    const modelOptions = createParsedModelOptionsHandler(
      async query => {
        discoverQueries.push(query);
        return { availableFilters: {}, typekeys: [{ typekey: "11EH", family: "G70", displayTerm: "740i" }], raw: { source: "BMW" } };
      },
      async () => null,
      async () => undefined,
    );
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/v1/models/options?manufacturer=BMW&modelSeries=7&includeRaw=true&unknown=value`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        manufacturer: "BMW",
        appliedFilters: { brand: "BMW", modelSeries: "7" },
        models: [{ id: "11EH", label: "740i", selection: { series: "7", typekeys: [{ typekey: "11EH", family: "G70" }] } }],
        complete: false,
        raw: { source: "BMW" },
      });
      expect(discoverQueries).toEqual([expect.objectContaining({ language: "en-GB", brand: "BMW", modelSeries: "7" })]);
      expect(JSON.stringify(discoverQueries[0])).not.toContain("unknown");

      for (const query of ["includeRaw=yes", "includeRaw=1", "brand=", "modelSeries=", "manufacturer=AUDI", "brand=BMW&brand=MINI"]) {
        const invalid = await fetch(`${baseUrl}/v1/models/options?${query}`);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      }
      const incompatible = await fetch(`${baseUrl}/v1/models/options?filterByType=11EH&brand=BMW`);
      expect(incompatible.status).toBe(400);
      expect(await incompatible.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "filterByType cannot be combined with brand, modelSeries or developmentCode" } });
    }, modelOptions);
    expect(discoverQueries).toHaveLength(1);
  });

  test("requires a series before accepting extraction requests", async () => {
    let createCalls = 0;
    let received: unknown;
    await withServer(async baseUrl => {
      const headers = { "content-type": "application/json" };
      const withoutSeries = await fetch(`${baseUrl}/v1/labours`, {
        method: "POST", headers,
        body: JSON.stringify({ manufacturer: "BMW", selection: { typekeys: [{ typekey: "11EH", family: "G70" }] } }),
      });
      expect(withoutSeries.status).toBe(400);
      expect(await withoutSeries.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "Each typekey requires a series (e.g. 7')" } });
      expect(createCalls).toBe(0);

      const valid = await fetch(`${baseUrl}/v1/labours`, {
        method: "POST", headers,
        body: JSON.stringify({ manufacturer: "BMW", selection: { series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] } }),
      });
      expect(valid.status).toBe(202);
      expect(createCalls).toBe(1);
      expect(received).toMatchObject({ manufacturer: "BMW", series: "7", date: "20261009", typekeys: [{ typekey: "11EH", family: "G70" }] });
    }, undefined, {
      createLabour: async input => { createCalls++; received = input; return "00000000-0000-4000-8000-000000000001"; },
    });
  });

  test("rejects malformed and oversized JSON extraction requests before creating jobs", async () => {
    let createCalls = 0;
    await withServer(async baseUrl => {
      const malformed = await fetch(`${baseUrl}/v1/labours`, { method: "POST", headers: { "content-type": "application/json" }, body: "{invalid" });
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${baseUrl}/v1/labours`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ manufacturer: "BMW", selection: { series: "7", typekeys: [{ typekey: "11EH", family: "G70" }], extra: "x".repeat(70_000) } }),
      });
      expect(oversized.status).toBe(413);
      expect(createCalls).toBe(0);
    }, undefined, { createLabour: async () => { createCalls++; return "00000000-0000-4000-8000-000000000001"; } });
  });
});
