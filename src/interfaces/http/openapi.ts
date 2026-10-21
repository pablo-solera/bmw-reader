import { z } from "zod";
import { generateOpenApiV1 } from "reader-core/contract/openapi";

export const bmwSelectionSchema = z.object({
  series: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  date: z.string().regex(/^\d{8}$/).optional(),
  typekeys: z.array(z.object({
    typekey: z.string().regex(/^[A-Z0-9]{4}$/),
    series: z.string().min(1).optional(),
    family: z.string().regex(/^[A-Z0-9]+$/),
    model: z.string().min(1).optional(),
  })).min(1),
});

export const docsHtml = '<!doctype html><html><head><title>BMW Reader API v1</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>';

export function buildBmwOpenApi(port: number) {
  return generateOpenApiV1({
    title: "BMW Reader API",
    version: "1.0.0",
    serverUrl: `http://localhost:${port}`,
    selectionSchemas: { BmwSelection: bmwSelectionSchema },
    paths: {
      "/v1/labours/{requestId}/archive.zip": { get: {
        tags: ["Labours"],
        summary: "Download all labour typekeys as a ZIP archive",
        parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "ZIP archive containing all generated artifacts for the extraction." }, "404": { description: "Extraction not found." }, "409": { description: "Extraction is not completed yet." } },
      } },
      "/v1/models/options": { get: {
        tags: ["Models"],
        summary: "Discover BMW model series, development codes, and typekeys",
        description: "Queries BMW Vehicle Type Research. Apply filters progressively to retrieve the next available filter values; filterByType must be used on its own. Each model result includes a selection object that can be submitted to POST /v1/labours.",
        parameters: [
          { name: "manufacturer", in: "query", description: "BMW manufacturer identifier; also used as the brand filter when brand is omitted.", schema: { type: "string", default: "BMW" } },
          { name: "brand", in: "query", description: "BMW brand filter, for example BMW or MINI.", schema: { type: "string" } },
          { name: "modelSeries", in: "query", description: "Filter by a model series such as 3 Series or X5.", schema: { type: "string" } },
          { name: "developmentCode", in: "query", description: "Filter by BMW development code.", schema: { type: "string" } },
          { name: "filterByType", in: "query", description: "Continue progressive filter discovery for a typekey, for example 11EH.", schema: { type: "string" } },
          { name: "language", in: "query", description: "Language/locale for BMW labels.", schema: { type: "string", default: "en-GB" } },
          { name: "includeRaw", in: "query", description: "Include the unmodified BMW response.", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": { description: "Available filters, models, and reusable selections." },
          "400": { description: "The manufacturer or filter combination is invalid." },
          "502": { description: "The BMW Vehicle Type Research API returned an error." },
        },
      } },
      "/v1/parts": { get: { tags: ["Parts"], summary: "List BMW parts requests (not supported)", description: "BMW Aftersales Flat Rates provides labour-time data only.", responses: { "501": { description: "Parts are not supported." } } }, post: { tags: ["Parts"], summary: "Create BMW parts request (not supported)", description: "BMW Aftersales Flat Rates provides labour-time data only.", responses: { "501": { description: "Parts are not supported." } } } },
      "/v1/parts/{requestId}": { get: { tags: ["Parts"], summary: "Get BMW parts request (not supported)", description: "BMW parts requests cannot be created by this reader.", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts status is not supported." } } } },
      "/v1/parts/{requestId}/download": { get: { tags: ["Parts"], summary: "Download BMW parts artifact (not supported)", description: "BMW parts artifacts are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts download is not supported." } } } },
      "/v1/parts/{requestId}/cancel": { post: { tags: ["Parts"], summary: "Cancel BMW parts request (not supported)", description: "BMW parts requests are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts cancellation is not supported." } } } },
      "/v1/parts/{requestId}/resume": { post: { tags: ["Parts"], summary: "Resume BMW parts request (not supported)", description: "BMW parts requests are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts resume is not supported." } } } },
    },
  });
}
