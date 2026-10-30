import { describe, expect, test } from "bun:test";
import { buildBmwOpenApi } from "../src/interfaces/http/openapi.js";
import { v1Paths } from "@solera/core-reader/contract/v1";

const openApiDocument = buildBmwOpenApi(3004);

describe("BMW Reader API v1", () => {
  test("has all versioned resources and no legacy unversioned API routes", () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    expect(paths["/v1/models/options"]?.get).toBeDefined();
    expect(paths["/v1/labours"]?.post).toBeDefined();
    expect(paths["/v1/labours/{requestId}/download"]?.get).toBeDefined();
    expect(paths["/v1/parts"]?.post).toBeDefined();
    expect(paths["/v1/metrics/throughput"]).toBeUndefined();
    expect(paths["/labours"]).toBeUndefined();
    expect(paths["/models/options"]).toBeUndefined();
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operationValue] of Object.entries(item)) {
        documented.add(`${method} ${path}`);
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const operation = operationValue as { tags?: string[]; summary?: string; description?: string };
        expect(Boolean(operation.tags?.length), `${method.toUpperCase()} ${path} should have a tag`).toBe(true);
        expect(operation.summary, `${method.toUpperCase()} ${path} should have an English summary`).toBeTruthy();
        expect(operation.description, `${method.toUpperCase()} ${path} should have an English description`).toBeTruthy();
        expect(operation.summary).toMatch(/^[A-Za-z0-9]/);
      }
    }
    for (const route of v1Paths) expect(documented.has(route)).toBe(true);
  });

  test("groups operations into reader-facing sections and describes BMW-specific routes in English", () => {
    const tags = new Set(((openApiDocument as unknown as { tags: Array<{ name: string }> }).tags).map(tag => tag.name));
    expect([...tags]).toEqual(["System", "Info", "Labours", "Parts", "Models"]);
    const paths = openApiDocument.paths as Record<string, Record<string, { tags?: string[]; summary?: string; description?: string; responses?: Record<string, unknown> }>>;
    const operations = Object.values(paths).flatMap(path => Object.values(path));
    for (const operation of operations) {
      expect(operation.tags?.length).toBeGreaterThan(0);
      expect(operation.summary).toBeTruthy();
      expect(operation.description).toBeTruthy();
    }
    expect(paths["/v1/models/options"]?.get?.summary).toContain("BMW");
    expect(paths["/v1/parts"]?.post?.responses).toBeDefined();
  });
});
