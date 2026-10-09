import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { buildBmwOpenApi, docsHtml, bmwCapability, unsupportedCapability } from "../src/interfaces/http/openapi.js";
import { capabilitiesSchema } from "reader-core/contract/v1";
import { checkV1HttpConformance } from "reader-core/testing/conformance";

async function withServer(run: (baseUrl: string) => Promise<void>, modelOptions = async () => ({ manufacturer: "BMW", appliedFilters: {}, filters: [], models: [], complete: false })) {
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
});
