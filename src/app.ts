import express, { type Express } from "express";
import { ApplicationError, NotFoundError, NotReadyError, UpstreamError, ValidationError, ConflictError } from "reader-core/domain/errors";
import { capabilitiesSchema, type Artifact, type CreateRequest, type RequestState } from "reader-core/contract/v1";
import { createSystemRouter } from "reader-core/interfaces/http/express/system-router";
import { createV1Router } from "reader-core/interfaces/http/express/v1-router";
import { readerErrorMiddleware, readerNotFoundMiddleware } from "reader-core/interfaces/http/express/error-middleware";
import { bmwCapability, bmwSelectionSchema, unsupportedCapability } from "./interfaces/http/openapi.js";
import { toBmwRequestSummary } from "./interfaces/http/state-mapper.js";
import type { AppDependencies } from "./interfaces/http/app-dependencies.js";

function errorFrom(error: unknown, statusDefault: "UPSTREAM_ERROR" | "UNAVAILABLE" = "UNAVAILABLE"): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR") throw new ValidationError(error.message);
  if (error instanceof Error && "statusCode" in error && Number(error.statusCode) === 404) throw new NotFoundError(error.message);
  if (error instanceof Error && "statusCode" in error && Number(error.statusCode) === 409) throw new ConflictError(error.message);
  if (error instanceof Error && /already has a queued or active job|already exists with status|lock ownership changed/i.test(error.message)) throw new ConflictError(error.message);
  if (error instanceof Error && /Invalid|requires a series|must use|calendar date|typekeys\/families\/models|contains invalid path characters|must contain letters|only letters, digits/i.test(error.message)) throw new ValidationError(error.message);
  if (statusDefault === "UPSTREAM_ERROR") throw new UpstreamError("BMW Vehicle Type Research request failed", undefined, { cause: error });
  throw new Error("Reader operation failed", { cause: error });
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(createSystemRouter(dependencies.openApi, dependencies.docsHtml, dependencies.readyChecks));
  const v1Router = createV1Router({
    reader: "bmw",
    version: "1.0.0",
    manufacturers: ["BMW", "MINI"],
    capabilities: capabilitiesSchema.parse({ labours: bmwCapability, parts: unsupportedCapability, models: { options: true } }),
    handlers: {
      labours: {
        create: async (body: CreateRequest) => {
          const selection = bmwSelectionSchema.parse(body.selection);
          if (selection.typekeys.some(item => !(item.series ?? selection.series))) throw new ValidationError("Each typekey requires a series (e.g. 7')");
          const date = selection.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
          try { return { requestId: await dependencies.createLabour({ ...body, ...selection, date }) }; }
          catch (error) { return errorFrom(error); }
        },
        list: async query => {
          try {
            const internalStatuses = query.status?.map(status => status === "running" ? "downloading" : status === "rate_limited" ? "rate-limited" : status);
            const page = await dependencies.listLabours({ status: internalStatuses, manufacturer: query.manufacturer, axCode: query.axCode, edition: query.edition }, query.cursor, query.limit);
            return { items: page.items.map(toBmwRequestSummary), nextCursor: page.nextCursor };
          } catch (error) { return errorFrom(error); }
        },
        get: async requestId => {
          try { const value = await dependencies.getState(requestId); return value?.resource === "labours" ? await dependencies.mapState(value) : null; }
          catch (error) { return errorFrom(error); }
        },
        download: async (requestId, artifactName) => {
          try {
            const value = await dependencies.getState(requestId);
            if (!value || value.resource !== "labours") throw new NotFoundError("Labour request not found", { requestId });
            const requestState = await dependencies.mapState(value);
            if (!artifactName) throw new NotReadyError("BMW labour requests do not have a single primary file", { artifacts: requestState?.artifacts });
            const artifact = requestState?.artifacts.find((item: Artifact) => item.name === artifactName);
            if (!artifact) throw new NotFoundError("Artifact not found", { requestId, artifact: artifactName });
            if (artifact.kind === "prefix") throw new ConflictError("S3 prefixes cannot be downloaded as a single file", { artifact: artifact.name });
            const markerReady = artifact.name.endsWith("_completed.json") && await dependencies.getArtifact(artifact.location.key) !== undefined;
            if (value.status !== "completed" && !markerReady) throw new NotReadyError("Artifact is not ready", { status: value.status, artifact: artifact.name });
            return await dependencies.signDownload(artifact.location.key);
          } catch (error) { return errorFrom(error); }
        },
        cancel: async requestId => {
          try {
            const result = await dependencies.cancelLabour(requestId);
            if (result.status !== "cancelled" && result.status !== "cancelling") throw new ConflictError("Request cannot be cancelled in its current state", { status: result.status });
            return { status: result.status, body: { requestId, status: result.status } };
          } catch (error) { return errorFrom(error); }
        },
        resume: async (requestId, force) => {
          try { return await dependencies.resumeLabour(requestId, force); }
          catch (error) {
            if (error instanceof Error && error.message === "Resumable extraction not found") throw new NotFoundError(error.message);
            return errorFrom(error);
          }
        },
      },
      modelsOptions: query => dependencies.modelOptions(query),
    },
  });
  app.use("/v1", v1Router);
  app.use(readerNotFoundMiddleware);
  app.use(readerErrorMiddleware);
  return app;
}
