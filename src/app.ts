import express from "express";
import { z } from "zod";
import { enqueueLabour, enqueueModel, getLabourOptions, isModelStalled, modelThroughput, resumeModel, state, workerLiveness } from "./jobs.js";
import { signedDownload } from "./storage.js";
import { getTypeResearchOptions } from "./bmw/type-research.js";
import { getBmwMetrics } from "./rate-metrics.js";
import { config } from "./config.js";
import { openApiDocument } from "./openapi.js";

const labourSchema = z.object({
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  family: z.string().min(1),
  typekey: z.string().regex(/^[A-Z0-9]{4}$/),
  date: z.string().regex(/^\d{8}$/).optional(),
  language: z.string().optional(),
});
const modelSchema = z.object({
  axCode: z.string().min(1).optional(),
  edition: z.string().min(1).optional(),
  manufacturer: z.string().min(1),
  model: z.string().min(1).optional(),
  date: z.string().regex(/^\d{8}$/).optional(),
  language: z.string().optional(),
  typekeys: z.array(z.object({ typekey: z.string().regex(/^[A-Z0-9]{4}$/), family: z.string().regex(/^[A-Z0-9]+$/), model: z.string().min(1).optional() })).min(1),
});

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
app.get("/docs", (_req, res) => res.type("html").send('<!doctype html><html><head><title>BMW Reader API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));

app.post("/labours/options", async (req, res) => {
  try {
    const body = z.object({ typekey: z.string().regex(/^[A-Z0-9]{4}$/) }).parse(req.body);
    return res.json(await getLabourOptions(body.typekey));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/labours", async (req, res) => {
  try {
    const body = labourSchema.parse(req.body);
    const date = body.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const requestId = await enqueueLabour({ manufacturer: body.manufacturer, model: body.model, family: body.family, typekeys: [body.typekey], axCode: "BMW", edition: date, group: "BMW", language: body.language });
    return res.status(202).json({ requestId, status: "queued", statusUrl: `/labours/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/labours/:requestId", async (req, res) => {
  try {
    const value = await state(req.params.requestId);
    if (!value || value.resource !== "labours") return res.status(404).json({ error: "Labour request not found" });
    return res.json({ ...value, downloadUrl: value.status === "completed" && value.s3Path ? `/labours/${value.requestId}/download` : undefined });
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/labours/:requestId/download", async (req, res) => {
  try {
    const value = await state(req.params.requestId);
    if (!value || value.resource !== "labours") return res.status(404).json({ error: "Labour request not found" });
    if (value.status !== "completed" || !value.s3Path) return res.status(409).json({ error: "Labour extraction is not ready", status: value.status });
    return res.redirect(307, await signedDownload(value.s3Path));
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/parts/options", (_req, res) => res.status(501).json({ error: "BMW Aftersales Flat Rates API provides labour-time data only; parts are not implemented" }));
app.post("/parts", (_req, res) => res.status(501).json({ error: "BMW Aftersales Flat Rates API provides labour-time data only; parts are not implemented" }));
app.get("/parts/:requestId", (_req, res) => res.status(501).json({ error: "BMW parts are not implemented" }));
app.get("/parts/:requestId/download", (_req, res) => res.status(501).json({ error: "BMW parts are not implemented" }));

app.get("/models/options", async (req, res) => {
  try {
    const query = z.object({
      brand: z.string().min(1).optional(),
      modelSeries: z.string().min(1).optional(),
      developmentCode: z.string().min(1).optional(),
      filterByType: z.string().min(1).optional(),
      language: z.string().min(1).default("en-GB"),
    }).parse(req.query);
    return res.json(await getTypeResearchOptions(query));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/metrics/throughput", async (_req, res) => {
  try {
    const metrics = await getBmwMetrics(undefined, 5);
    return res.json({
      configuredRatePerSecond: config.BMW_RATE_LIMIT_PER_SEC,
      configuredAwSheetConcurrency: config.BMW_AW_SHEET_CONCURRENCY,
      configuredJobConcurrency: config.JOB_CONCURRENCY,
      ...metrics,
    });
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/models", async (req, res) => {
  try {
    const body = modelSchema.parse(req.body);
    const date = body.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const requestId = await enqueueModel({ ...body, date });
    return res.status(202).json({ requestId, status: "queued", statusUrl: `/models/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/models/:requestId", async (req, res) => {
  try {
    const value = await state(req.params.requestId);
    if (!value || value.resource !== "models") return res.status(404).json({ error: "Model extraction not found" });
    const [worker, throughput, stalled] = await Promise.all([workerLiveness(), modelThroughput(value.requestId), isModelStalled(value.requestId, value)]);
    return res.json({ ...value, worker, throughput, stalled, downloadUrl: value.status === "completed" && value.s3Path ? `/models/${value.requestId}/download` : undefined });
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/models/:requestId/resume", async (req, res) => {
  try {
    const body = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    return res.status(202).json(await resumeModel(req.params.requestId, body.force));
  } catch (error) {
    return res.status(error instanceof Error && error.message.startsWith("Resumable extraction not found") ? 404 : 409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/models/:requestId/download", async (req, res) => {
  try {
    const value = await state(req.params.requestId);
    if (!value || value.resource !== "models") return res.status(404).json({ error: "Model extraction not found" });
    if (value.status !== "completed" || !value.s3Path) return res.status(409).json({ error: "Model extraction is not ready", status: value.status });
    return res.redirect(307, await signedDownload(value.s3Path));
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});
