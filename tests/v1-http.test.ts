import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { app, validateModelOptionsFilters } from "../src/app.js";
import { checkV1HttpConformance } from "reader-core/testing/conformance";

async function withServer(run: (baseUrl: string) => Promise<void>) {
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

  test("accepts manufacturer as the canonical brand filter when filtering by type", () => {
    expect(validateModelOptionsFilters({ manufacturer: "BMW", filterByType: "11EH" })).toEqual({ effectiveBrand: undefined });
    expect(validateModelOptionsFilters({ manufacturer: "BMW" })).toEqual({ effectiveBrand: "BMW" });
    expect(() => validateModelOptionsFilters({ brand: "BMW", filterByType: "11EH" })).toThrow("filterByType cannot be combined");
  });

  test("returns a validation error for incompatible model-options filters before calling BMW", async () => {
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/v1/models/options?brand=BMW&filterByType=11EH`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
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
