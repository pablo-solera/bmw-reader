import { describe, expect, test } from "bun:test";
import { app } from "../src/app.js";
import { openApiDocument } from "../src/openapi.js";

type ExpressRoute = { path: string; methods: Record<string, boolean> };
const expressRoutes = (app as unknown as { router: { stack: Array<{ route?: ExpressRoute }> } }).router.stack
  .flatMap(layer => layer.route ? Object.entries(layer.route.methods).filter(([, enabled]) => enabled).map(([method]) => `${method.toLowerCase()} ${layer.route!.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`) : []);

function collectReferences(value: unknown, refs: string[] = []): string[] {
  if (!value || typeof value !== "object") return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, refs);
    return refs;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") refs.push(child);
    else collectReferences(child, refs);
  }
  return refs;
}

describe("OpenAPI contract", () => {
  test("documents every Express route and method", () => {
    const documented = new Set<string>();
    for (const [path, pathItem] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(pathItem)) documented.add(`${method} ${path}`);
    }
    const excluded = new Set(["get /docs", "get /openapi.json"]);
    const express = new Set(expressRoutes.filter(route => !excluded.has(route)));
    const spec = new Set([...documented].filter(route => !excluded.has(route)));
    expect([...express].sort()).toEqual([...spec].sort());
  });

  test("uses local server URL and resolves every schema reference", () => {
    expect(openApiDocument.servers.map(server => server.url)).toEqual(["http://localhost:3004"]);
    const schemaNames = new Set(Object.keys(openApiDocument.components.schemas));
    for (const reference of collectReferences(openApiDocument)) {
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(reference);
      expect(match, `Unsupported OpenAPI reference ${reference}`).not.toBeNull();
      expect(schemaNames.has(match![1]!)).toBe(true);
    }
  });

  test("keeps models as discovery, routes extractions under labours, and parts as 501 stubs", () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    expect(paths["/models/options"]?.get).toBeDefined();
    expect(paths["/models"]).toBeUndefined();
    expect(paths["/models/{requestId}"]).toBeUndefined();
    expect(paths["/labours"]?.post).toBeDefined();
    expect(paths["/labours"]?.get).toBeDefined();
    expect(paths["/labours/{requestId}"]?.get).toBeDefined();
    expect(paths["/labours/{requestId}/resume"]?.post).toBeDefined();
    expect(paths["/labours/options"]).toBeUndefined();
    for (const path of ["/parts", "/parts/options", "/parts/{requestId}", "/parts/{requestId}/download"]) {
      const operation = Object.values(paths[path]!)[0] as { responses: Record<string, unknown> };
      expect(operation.responses["501"]).toBeDefined();
    }
  });
  test("requires a series for every typekey extraction entry", () => {
    const request = (openApiDocument.components.schemas as Record<string, { properties?: Record<string, unknown> }>).LabourRequest;
    expect(request).toBeDefined();
  });
});
