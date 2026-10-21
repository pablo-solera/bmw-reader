import express, { type Express } from "express";
import { ValidationError, ConflictError } from "reader-core/domain/errors";
import type { CreateRequest } from "reader-core/contract/v1";
import { createSystemRouter } from "reader-core/interfaces/http/express/system-router";
import { createV1Router } from "reader-core/interfaces/http/express/v1-router";
import { readerErrorMiddleware, readerNotFoundMiddleware } from "reader-core/interfaces/http/express/error-middleware";
import { bmwSelectionSchema } from "./interfaces/http/openapi.js";
import { toBmwRequestSummary } from "./interfaces/http/state-mapper.js";
import type { AppDependencies } from "./interfaces/http/app-dependencies.js";

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(createSystemRouter(dependencies.openApi, dependencies.docsHtml, dependencies.readyChecks));
  app.get("/v1/labours/:requestId/archive.zip", (req, res, next) => {
    const requestId = req.params.requestId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      next(new ValidationError("requestId must be a UUID"));
      return;
    }
    void dependencies.createLabourArchive(requestId).then(({ stream, start }) => {
      res.status(200).type("application/zip").attachment(`bmw-extraction-${requestId}.zip`);
      stream.on("error", error => res.destroy(error));
      stream.pipe(res);
      start();
    }).catch(next);
  });
  const v1Router = createV1Router({
    reader: "bmw",
    version: "1.0.0",
    manufacturers: ["BMW", "MINI"],
    handlers: {
      labours: {
        create: async (body: CreateRequest) => {
          const selection = bmwSelectionSchema.parse(body.selection);
          return { requestId: await dependencies.createLabour({
            manufacturer: body.manufacturer,
            ...(body.axCode ? { axCode: body.axCode } : {}),
            ...(body.edition ? { edition: body.edition } : {}),
            ...(body.language ? { language: body.language } : {}),
            ...selection,
          }) };
        },
        list: async query => {
          const page = await dependencies.listLabours({ status: query.status, manufacturer: query.manufacturer, axCode: query.axCode, edition: query.edition }, query.cursor, query.limit);
          return { items: page.items.map(toBmwRequestSummary), nextCursor: page.nextCursor };
        },
        get: async requestId => {
          const value = await dependencies.getState(requestId);
          return value ? dependencies.mapState(value) : null;
        },
        download: (requestId, artifactName) => dependencies.downloadArtifact(requestId, artifactName),
        cancel: async requestId => {
          const result = await dependencies.cancelLabour(requestId);
          if (result.status !== "cancelled" && result.status !== "cancelling") throw new ConflictError("Request cannot be cancelled in its current state", { status: result.status });
          return { status: result.status, body: { requestId, status: result.status } };
        },
        resume: async (requestId, force) => dependencies.resumeLabour(requestId, force),
      },
      modelsOptions: query => dependencies.modelOptions(query),
    },
  });
  app.use("/v1", v1Router);
  app.use(readerNotFoundMiddleware);
  app.use(readerErrorMiddleware);
  return app;
}
