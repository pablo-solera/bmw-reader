import express from "express";
import { z } from "zod";
import { enqueueLabour, isLabourStalled, labourThroughput, resumeLabour, state, workerLiveness } from "./jobs.js";
import { getTypeResearchOptions } from "./bmw/type-research.js";
import { getBmwMetrics } from "./rate-metrics.js";
import { config } from "./config.js";
import { openApiDocument } from "./openapi.js";

const labourSchema = z.object({
  axCode: z.string().min(1).optional(),
  edition: z.string().min(1).optional(),
  manufacturer: z.string().min(1),
  series: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  date: z.string().regex(/^\d{8}$/).optional(),
  language: z.string().optional(),
  typekeys: z.array(z.object({ typekey: z.string().regex(/^[A-Z0-9]{4}$/), series: z.string().min(1).optional(), family: z.string().regex(/^[A-Z0-9]+$/), model: z.string().min(1).optional() })).min(1),
});

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
app.get("/docs", (_req, res) => res.type("html").send('<!doctype html><html><head><title>BMW Reader API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));

app.post("/labours", async (req, res) => {
  try {
    const body = labourSchema.parse(req.body);
    const date = body.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (body.typekeys.some(typekey => !(typekey.series ?? body.series))) return res.status(400).json({ error: "Each typekey requires a series (e.g. 7')" });
    const requestId = await enqueueLabour({ ...body, date });
    return res.status(202).json({ requestId, status: "queued", statusUrl: `/labours/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/labours/:requestId", async (req, res) => {
  try {
    const value = await state(req.params.requestId);
    if (!value || !["labours", "models"].includes(value.resource ?? "")) return res.status(404).json({ error: "Labour request not found" });
    const [worker, throughput, stalled] = await Promise.all([workerLiveness(), labourThroughput(value.requestId), isLabourStalled(value.requestId, value)]);
    const legacyState = value as typeof value & { s3Path?: string };
    const { s3Path: _legacyS3Path, ...stateValue } = legacyState;
    return res.json({ ...stateValue, resource: "labours", worker, throughput, stalled });
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/labours/:requestId/resume", async (req, res) => {
  try {
    const body = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    return res.status(202).json(await resumeLabour(req.params.requestId, body.force));
  } catch (error) {
    return res.status(error instanceof Error && error.message.startsWith("Resumable extraction not found") ? 404 : 409).json({ error: error instanceof Error ? error.message : String(error) });
  }
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

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});
