import express from "express";
import { z } from "zod";
import { enqueueExtraction, state } from "./jobs.js";
import { signedDownload } from "./storage.js";

const inputSchema = z.object({
  dataRequestId: z.string().min(1).optional(),
  manufacturer: z.string().min(1).optional(), model: z.string().min(1).optional(), family: z.string().min(1).optional(),
  axCode: z.string().min(1).optional(), edition: z.string().min(1).optional(), typekeys: z.array(z.string().regex(/^[A-Z0-9]{4}$/)).min(1).optional(),
  group: z.string().optional(), language: z.string().optional(),
}).refine(value => !!value.dataRequestId || (!!value.manufacturer && !!value.model && !!value.family && !!value.axCode && !!value.edition && !!value.typekeys?.length), {
  message: "Use dataRequestId or provide manufacturer, model, family, axCode, edition and typekeys",
}).refine(value => !value.typekeys || new Set(value.typekeys).size === value.typekeys.length, { message: "typekeys must be unique" });

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/openapi.json", (_req, res) => res.json({ openapi: "3.0.3", info: { title: "BMW Reader API", version: "1.0.0" }, paths: {
  "/extractions": { post: { summary: "Enqueue a BMW labour extraction", responses: { "202": { description: "Accepted" } } } },
  "/extractions/{id}": { get: { summary: "Get extraction status" } },
} }));
app.get("/docs", (_req, res) => res.type("html").send('<!doctype html><html><head><title>BMW Reader API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));
app.post("/extractions", async (req, res, next) => {
  try {
    const parsed = inputSchema.parse(req.body);
    const input = parsed.dataRequestId ? { dataRequestId: parsed.dataRequestId } : parsed as never;
    const requestId = await enqueueExtraction(input);
    res.status(202).json({ requestId, status: "queued", statusUrl: `/extractions/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return next(error);
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/extractions/:id", async (req, res, next) => {
  try { const value = await state(req.params.id); if (!value) return res.status(404).json({ error: "Extraction not found" }); res.json(value); }
  catch (error) { next(error); }
});
app.get("/extractions/:id/download", async (req, res, next) => {
  try {
    const value = await state(req.params.id);
    if (!value) return res.status(404).json({ error: "Extraction not found" });
    const reportKey = value.reportKey;
    if (!reportKey) return res.status(404).json({ error: "Report key not found" });
    return res.redirect(307, await signedDownload(reportKey));
  } catch (error) { next(error); }
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ error: message });
});
