import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildOpenApiV1, createSystemRouter, createV1Router, ReaderError, readerErrorMiddleware, readerNotFoundMiddleware } from "reader-core/http/v1";
import { capabilitiesSchema, toRequestStatus, type Artifact, type CreateRequest, type RequestState, type RequestSummary } from "reader-core/contract/v1";
import { cancelLabour, enqueueLabour, isLabourStalled, listLabours, readyCheck, resumeLabour, state, workerLiveness } from "./jobs.js";
import { getTypeResearchOptions } from "./bmw/type-research.js";
import { typekeyArtifacts } from "./bmw/fetch-typekey.js";
import { config } from "./config.js";
import { checkBucket, getJsonIfExists, signedDownload } from "./storage.js";
import { redis } from "./redis.js";

const bmwSelectionSchema = z.object({
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

export function validateModelOptionsFilters(query: { brand?: string; manufacturer?: string; modelSeries?: string; developmentCode?: string; filterByType?: string }) {
  const effectiveBrand = query.filterByType ? query.brand : query.brand ?? query.manufacturer;
  if (query.filterByType && (effectiveBrand || query.modelSeries || query.developmentCode)) throw new ReaderError("VALIDATION_ERROR", "filterByType cannot be combined with brand, modelSeries or developmentCode", 400);
  return { effectiveBrand };
}

function errorFrom(error: unknown, statusDefault = 500): never {
  if (error instanceof ReaderError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/already has a queued or active job|already exists with status|lock ownership changed/i.test(message)) throw new ReaderError("CONFLICT", message, 409);
  if (error && typeof error === "object" && "code" in error && error.code === "VALIDATION_ERROR") throw new ReaderError("VALIDATION_ERROR", message, 400);
  if (/Invalid|requires a series|must use|calendar date|typekeys\/families\/models|contains invalid path characters|must contain letters|only letters, digits/i.test(message)) throw new ReaderError("VALIDATION_ERROR", message, 400);
  if (statusDefault === 502) throw new ReaderError("UPSTREAM_ERROR", message, 502);
  throw new ReaderError("UNAVAILABLE", message, 503);
}

function bmwRequestFrom(value: NonNullable<Awaited<ReturnType<typeof state>>>): CreateRequest {
  const input = value.input;
  const summary = value.extractionSummary;
  return {
    manufacturer: input?.manufacturer ?? "BMW",
    ...(input?.axCode ? { axCode: input.axCode } : {}),
    ...(input?.edition ? { edition: input.edition } : {}),
    ...(input?.language ? { language: input.language } : {}),
    selection: {
      ...(input?.series ? { series: input.series } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(summary?.date ? { date: summary.date } : {}),
      typekeys: (summary?.typekeys ?? []).map(item => ({ typekey: item.typekey, series: item.series, family: item.family, ...(item.model ? { model: item.model } : {}) })),
    },
  };
}

async function toBmwRequestState(value: NonNullable<Awaited<ReturnType<typeof state>>>): Promise<RequestState> {
  const input = value.input;
  const summary = value.extractionSummary;
  const artifacts: Artifact[] = input && summary ? typekeyArtifacts({ ...input, date: summary.date }, summary.typekeys, config.S3_BUCKET) : [];
  const [worker, stalled] = await Promise.all([workerLiveness(), isLabourStalled(value.requestId, value)]);
  return {
    requestId: value.requestId,
    resource: "labours",
    reader: "bmw",
    status: toRequestStatus(value.status),
    stage: value.stage,
    progress: value.progress,
    request: bmwRequestFrom(value),
    artifacts,
    error: value.error ? { code: "INTERNAL_ERROR", message: value.error } : null,
    details: { typekeys: summary?.typekeys ?? [], worker, stalled, rateLimitInfo: value.rateLimitInfo ?? null },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.status === "completed" ? value.updatedAt : null,
  };
}

const bmwCapability = { create: true, list: true, cancel: true, resume: true, download: true };
const unsupportedCapability = { create: false, list: false, cancel: false, resume: false, download: false };
const docsHtml = '<!doctype html><html><head><title>BMW Reader API v1</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>';

const openApiBase = buildOpenApiV1({
  title: "BMW Reader API",
  version: "0.2.0",
  serverUrl: `http://localhost:${config.PORT}`,
  selectionSchemas: {
    BmwSelection: { type: "object", required: ["typekeys"], properties: { series: { type: "string" }, model: { type: "string" }, date: { type: "string", pattern: "^\\d{8}$" }, typekeys: { type: "array", minItems: 1, items: { type: "object", required: ["typekey", "family"], properties: { typekey: { type: "string", pattern: "^[A-Z0-9]{4}$" }, series: { type: "string" }, family: { type: "string", pattern: "^[A-Z0-9]+$" }, model: { type: "string" } } } } } },
  },
  paths: {
    "/v1/models/options": { get: {
      tags: ["Models"],
      summary: "Discover BMW model series, development codes, and typekeys",
      description: "Queries BMW Vehicle Type Research. Apply filters progressively to retrieve the next available filter values; filterByType must be used on its own. Each model result includes a selection object that can be submitted to POST /v1/labours.",
      parameters: [
        { name: "manufacturer", in: "query", description: "BMW manufacturer identifier; also used as the brand filter when brand is omitted.", schema: { type: "string", default: "BMW" } },
        { name: "brand", in: "query", description: "BMW brand filter, for example BMW or MINI.", schema: { type: "string" } },
        { name: "modelSeries", in: "query", description: "Filter by a model series such as 3 Series or X5.", schema: { type: "string" } },
        { name: "developmentCode", in: "query", description: "Filter by BMW development code.", schema: { type: "string" } },
        { name: "filterByType", in: "query", description: "Filter directly by a four-character typekey. Do not combine with modelSeries or developmentCode.", schema: { type: "string", pattern: "^[A-Z0-9]{4}$" } },
        { name: "language", in: "query", description: "BMW API language tag.", schema: { type: "string", default: "en-GB" } },
        { name: "includeRaw", in: "query", description: "Include the raw BMW response when true.", schema: { type: "boolean", default: false } },
      ],
      responses: {
        "200": { description: "Normalized filters and model options.", content: { "application/json": { schema: { type: "object", required: ["manufacturer", "appliedFilters", "filters", "models", "complete"], properties: { manufacturer: { type: "string" }, appliedFilters: { type: "object", additionalProperties: { type: "string" } }, filters: { type: "array", items: { type: "object", properties: { name: { type: "string" }, label: { type: "string" }, values: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, count: { type: "integer" } } } } } } }, models: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, attributes: { type: "object", additionalProperties: true }, selection: { $ref: "#/components/schemas/BmwSelection" } } } }, complete: { type: "boolean" }, raw: { description: "Unmodified BMW response, present only when includeRaw=true." } } } } } },
        "400": { description: "Invalid filter values or incompatible filters." },
        "502": { description: "The BMW Vehicle Type Research API returned an error." },
      },
    } },
    "/v1/parts": {
      get: { tags: ["Parts"], summary: "List BMW parts requests (not supported)", description: "BMW Aftersales Flat Rates provides labour-time data only; parts extraction is not implemented.", responses: { "501": { description: "Parts listing is not supported by BMW." } } },
      post: { tags: ["Parts"], summary: "Create a BMW parts request (not supported)", description: "BMW Aftersales Flat Rates provides labour-time data only; parts extraction is not implemented.", responses: { "501": { description: "Parts extraction is not supported by BMW." } } },
    },
    "/v1/parts/{requestId}": { get: { tags: ["Parts"], summary: "Get BMW parts request status (not supported)", description: "BMW parts requests cannot be created by this reader.", parameters: [{ name: "requestId", in: "path", required: true, description: "Request UUID.", schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts status lookup is not supported by BMW." } } } },
    "/v1/parts/{requestId}/download": { get: { tags: ["Parts"], summary: "Download a BMW parts artifact (not supported)", description: "BMW parts artifacts are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, description: "Request UUID.", schema: { type: "string", format: "uuid" } }, { name: "artifact", in: "query", description: "Artifact name.", schema: { type: "string" } }], responses: { "501": { description: "Parts downloads are not supported by BMW." } } } },
    "/v1/parts/{requestId}/cancel": { post: { tags: ["Parts"], summary: "Cancel a BMW parts request (not supported)", description: "BMW parts requests are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, description: "Request UUID.", schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts cancellation is not supported by BMW." } } } },
    "/v1/parts/{requestId}/resume": { post: { tags: ["Parts"], summary: "Resume a BMW parts request (not supported)", description: "BMW parts requests are not produced by this reader.", parameters: [{ name: "requestId", in: "path", required: true, description: "Request UUID.", schema: { type: "string", format: "uuid" } }], responses: { "501": { description: "Parts resume is not supported by BMW." } } } },
  },
});
const openApiDocument = {
  ...openApiBase,
  tags: (openApiBase as unknown as { tags: Array<{ name: string; description: string }> }).tags,
  components: {
    ...openApiBase.components,
    schemas: {
      ...openApiBase.components.schemas,
      CreateRequest: {
        ...openApiBase.components.schemas.CreateRequest,
        properties: { ...openApiBase.components.schemas.CreateRequest.properties, selection: { $ref: "#/components/schemas/BmwSelection" } },
      },
    },
  },
  paths: {
    ...openApiBase.paths,
  },
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(createSystemRouter(openApiDocument, docsHtml, { redis: () => redis.ping(), s3: checkBucket, worker: readyCheck }));
const v1Router = createV1Router({
  reader: "bmw",
  version: "1.0.0",
  manufacturers: ["BMW", "MINI"],
  capabilities: capabilitiesSchema.parse({ labours: bmwCapability, parts: unsupportedCapability, models: { options: true } }),
  handlers: {
    labours: {
      create: async (body: CreateRequest) => {
        const selection = bmwSelectionSchema.parse(body.selection);
        if (selection.typekeys.some(item => !(item.series ?? selection.series))) throw new ReaderError("VALIDATION_ERROR", "Each typekey requires a series (e.g. 7')", 400);
        try {
          const date = selection.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const requestId = await enqueueLabour({ ...body, ...selection, date });
          return { requestId };
        } catch (error) { return errorFrom(error); }
      },
      list: async query => {
        try {
          const internalStatuses = query.status?.map(status => status === "running" ? "downloading" : status === "rate_limited" ? "rate-limited" : status);
          const page = await listLabours({ status: internalStatuses, manufacturer: query.manufacturer, axCode: query.axCode, edition: query.edition }, query.cursor, query.limit);
          const items: RequestSummary[] = page.items.map(item => ({
            requestId: item.requestId, resource: "labours", reader: "bmw", status: toRequestStatus(item.status), stage: item.stage, progress: item.progress,
            request: { manufacturer: item.manufacturer, ...(item.axCode ? { axCode: item.axCode } : {}), edition: item.edition, selection: { date: item.date, typekeys: item.typekeys.map(key => ({ typekey: key.typekey, series: key.series, family: key.family, model: key.model })) } },
            error: item.error ? { code: "INTERNAL_ERROR", message: item.error } : null, createdAt: item.createdAt, updatedAt: item.updatedAt,
            completedAt: item.status === "completed" ? item.updatedAt : null, artifactCount: item.typekeys.length * 2,
          }));
          return { items, nextCursor: page.nextCursor };
        } catch (error) { return errorFrom(error); }
      },
      get: async requestId => {
        try {
          const value = await state(requestId);
          if (!value || value.resource !== "labours") return null;
          return await toBmwRequestState(value);
        } catch (error) { return errorFrom(error); }
      },
      download: async (requestId, artifactName) => {
        try {
          const value = await state(requestId);
          if (!value || value.resource !== "labours") throw new ReaderError("NOT_FOUND", "Labour request not found", 404, { requestId });
          const requestState = await toBmwRequestState(value);
          if (!artifactName) throw new ReaderError("NOT_READY", "BMW labour requests do not have a single primary file", 409, { artifacts: requestState.artifacts });
          const artifact = requestState.artifacts.find(item => item.name === artifactName);
          if (!artifact) throw new ReaderError("NOT_FOUND", "Artifact not found", 404, { requestId, artifact: artifactName });
          if (artifact.kind === "prefix") throw new ReaderError("NOT_DOWNLOADABLE", "S3 prefixes cannot be downloaded as a single file", 409, { artifact: artifact.name, location: artifact.location });
          const markerReady = artifact.name.endsWith("_completed.json") && await getJsonIfExists(artifact.location.key) !== undefined;
          if (value.status !== "completed" && !markerReady) {
            throw new ReaderError("NOT_READY", "Artifact is not ready", 409, { status: toRequestStatus(value.status), artifact: artifact.name });
          }
          return await signedDownload(artifact.location.key);
        } catch (error) { return errorFrom(error); }
      },
      cancel: async requestId => {
        try {
          const result = await cancelLabour(requestId);
          return { statusCode: result.status === "cancelling" ? 202 : 200, body: { requestId, status: result.status } };
        } catch (error) {
          if (error && typeof error === "object" && "statusCode" in error) {
            const status = Number(error.statusCode);
            throw new ReaderError(status === 404 ? "NOT_FOUND" : "CONFLICT", error instanceof Error ? error.message : String(error), status);
          }
          return errorFrom(error);
        }
      },
      resume: async (requestId, force) => {
        try { return await resumeLabour(requestId, force); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "Resumable extraction not found") throw new ReaderError("NOT_FOUND", message, 404);
          throw new ReaderError("CONFLICT", message, 409);
        }
      },
    },
    modelsOptions: async queryValue => {
      const query = z.object({
        manufacturer: z.string().min(1).optional(), language: z.string().min(1).default("en-GB"), includeRaw: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
        brand: z.string().min(1).optional(), modelSeries: z.string().min(1).optional(), developmentCode: z.string().min(1).optional(), filterByType: z.string().min(1).optional(),
      }).parse(queryValue);
      const { effectiveBrand } = validateModelOptionsFilters(query);
      try {
        const cacheKey = `bmw-reader:vehicle-options:${createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries({ ...query, brand: effectiveBrand }).sort(([left], [right]) => left.localeCompare(right))))).digest("hex")}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as unknown;
        const result = await getTypeResearchOptions({ ...query, brand: effectiveBrand });
        const appliedFilters: Record<string, string> = {};
        if (effectiveBrand) appliedFilters.brand = effectiveBrand;
        if (query.modelSeries) appliedFilters.modelSeries = query.modelSeries;
        if (query.developmentCode) appliedFilters.developmentCode = query.developmentCode;
        if (query.filterByType) appliedFilters.filterByType = query.filterByType;
        const filters = Object.entries(result.availableFilters).map(([name, values]) => ({
          name,
          values: Array.isArray(values) ? values.map(value => typeof value === "string" ? { value, label: value } : {
            value: String((value as Record<string, unknown>).searchTerm ?? (value as Record<string, unknown>).value ?? ""),
            label: String((value as Record<string, unknown>).displayTerm ?? (value as Record<string, unknown>).label ?? (value as Record<string, unknown>).searchTerm ?? ""),
          }).filter(item => item.value) : [],
        }));
          const models = result.typekeys.flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const record = value as Record<string, unknown>;
          const typekey = String(record.typekey ?? record.typeCode ?? "");
          const family = String(record.family ?? record.developmentCode ?? record.baseType ?? query.developmentCode ?? "");
            return typekey ? [{ id: typekey, label: String(record.displayTerm ?? record.model ?? typekey), attributes: record, selection: { ...(query.modelSeries ? { series: query.modelSeries } : {}), typekeys: [{ typekey, family, ...(record.model ? { model: String(record.model) } : {}) }] } }] : [];
          });
        const response = { manufacturer: query.manufacturer ?? query.brand ?? "BMW", appliedFilters, filters, models, complete: Boolean(query.filterByType), ...(query.includeRaw ? { raw: result.raw } : {}) };
        await redis.set(cacheKey, JSON.stringify(response), "EX", 86400);
        return response;
      } catch (error) {
        if (error instanceof ReaderError) throw error;
        return errorFrom(error, 502);
      }
    },
  },
});
app.use("/v1", v1Router);
app.use(readerNotFoundMiddleware);
app.use(readerErrorMiddleware);

export { app, openApiDocument, v1Router };
