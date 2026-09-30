const jsonResponse = (description: string, schema: unknown = { type: "object", additionalProperties: true }) => ({
  description,
  content: { "application/json": { schema } },
});
const errorResponse = jsonResponse("Error de la solicitud", { $ref: "#/components/schemas/Error" });
const requestIdParameter = { name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } };

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "BMW Reader API",
    version: "1.0.0",
    description: "API para descubrir vehículos BMW y encolar extracciones de tiempos de trabajo Aftersales. Las extracciones se procesan de forma asíncrona y almacenan sus datos crudos en S3.",
  },
  servers: [{ url: "http://localhost:3004", description: "Servidor local" }],
  tags: [
    { name: "Sistema", description: "Salud y documentación de la API" },
    { name: "Labours", description: "Encolado y estado de las extracciones de tiempos" },
    { name: "Models", description: "Descubrimiento de modelos y typekeys disponibles" },
    { name: "Métricas", description: "Throughput del cliente BMW" },
    { name: "Parts", description: "Rutas reservadas; BMW Aftersales Flat Rates no ofrece partes" },
  ],
  paths: {
    "/health": { get: { tags: ["Sistema"], summary: "Comprobar disponibilidad de la API", responses: { "200": jsonResponse("API disponible", { $ref: "#/components/schemas/Health" }) } } },
    "/openapi.json": { get: { tags: ["Sistema"], summary: "Obtener esta especificación OpenAPI", responses: { "200": { description: "Especificación OpenAPI 3.0.3 en JSON" } } } },
    "/docs": { get: { tags: ["Sistema"], summary: "Abrir la interfaz Swagger UI", responses: { "200": { description: "Página HTML de Swagger UI", content: { "text/html": { schema: { type: "string" } } } } } } },
    "/labours": {
      post: {
        tags: ["Labours"], summary: "Encolar una extracción con uno o varios typekeys", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LabourRequest" }, example: { manufacturer: "BMW", date: "20260928", typekeys: [{ typekey: "21EJ", series: "7'", family: "G70", model: "740d xDrive" }] } } } },
        responses: { "202": jsonResponse("Extracción encolada", { $ref: "#/components/schemas/Enqueued" }), "400": errorResponse, "502": errorResponse },
      },
    },
    "/labours/{requestId}": { get: { tags: ["Labours"], summary: "Consultar estado y throughput de una extracción", parameters: [requestIdParameter], responses: { "200": jsonResponse("Estado de extracción", { $ref: "#/components/schemas/LabourState" }), "404": errorResponse, "500": errorResponse } } },
    "/labours/{requestId}/resume": { post: { tags: ["Labours"], summary: "Reanudar extracción desde Redis y los datos existentes en S3", parameters: [requestIdParameter], requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/ResumeRequest" }, example: { force: false } } } }, responses: { "202": jsonResponse("Reanudación encolada", { $ref: "#/components/schemas/ResumeResponse" }), "404": errorResponse, "409": errorResponse } } },
    "/models/options": {
      get: {
        tags: ["Models"], summary: "Descubrir series, códigos de desarrollo y typekeys BMW", parameters: [
          { name: "brand", in: "query", schema: { type: "string" }, description: "Marca, por ejemplo BMW" },
          { name: "modelSeries", in: "query", schema: { type: "string" }, description: "Serie; puede contener apóstrofes codificados" },
          { name: "developmentCode", in: "query", schema: { type: "string" } },
          { name: "filterByType", in: "query", schema: { type: "string" }, description: "Typekey; no se combina con otros filtros" },
          { name: "language", in: "query", schema: { type: "string", default: "en-GB" } },
        ], responses: { "200": jsonResponse("Opciones y respuesta BMW original", { $ref: "#/components/schemas/ModelOptions" }), "400": errorResponse, "500": errorResponse, "502": errorResponse },
      },
    },
    "/metrics/throughput": { get: { tags: ["Métricas"], summary: "Consultar métricas BMW agregadas de los últimos cinco minutos", responses: { "200": jsonResponse("Throughput agregado", { $ref: "#/components/schemas/Throughput" }), "500": errorResponse } } },
    "/parts/options": { post: { tags: ["Parts"], summary: "Ruta no implementada: BMW no ofrece datos de partes en Flat Rates", responses: { "501": errorResponse } } },
    "/parts": { post: { tags: ["Parts"], summary: "Ruta no implementada: BMW no ofrece datos de partes en Flat Rates", responses: { "501": errorResponse } } },
    "/parts/{requestId}": { get: { tags: ["Parts"], summary: "Ruta no implementada para extracción de partes BMW", parameters: [requestIdParameter], responses: { "501": errorResponse } } },
    "/parts/{requestId}/download": { get: { tags: ["Parts"], summary: "Ruta no implementada para descargar partes BMW", parameters: [requestIdParameter], responses: { "501": errorResponse } } },
  },
  components: {
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, status: { type: "string" } } },
      Health: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["ok"] } } },
      Enqueued: { type: "object", required: ["requestId", "status", "statusUrl"], properties: { requestId: { type: "string", format: "uuid" }, status: { type: "string", example: "queued" }, statusUrl: { type: "string", example: "/labours/{requestId}" } } },
      Typekey: { type: "object", required: ["typekey", "family"], properties: { typekey: { type: "string", pattern: "^[A-Z0-9]{4}$" }, series: { type: "string", description: "Serie BMW para este typekey; obligatoria aquí si no se indicó en LabourRequest.series. Se quitan apóstrofes (7' → 7)." }, family: { type: "string", pattern: "^[A-Z0-9]+$" }, model: { type: "string", description: "Nombre descriptivo, no se usa como carpeta S3" } } },
      LabourRequest: { type: "object", required: ["manufacturer", "typekeys"], properties: { axCode: { type: "string" }, edition: { type: "string" }, manufacturer: { type: "string" }, series: { type: "string", description: "Serie común obligatoria si no se repite por typekey" }, model: { type: "string" }, date: { type: "string", pattern: "^\\d{8}$" }, language: { type: "string" }, typekeys: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/Typekey" } } } },
      ModelRequest: { type: "object", required: ["manufacturer", "typekeys"], properties: { axCode: { type: "string" }, edition: { type: "string" }, manufacturer: { type: "string" }, series: { type: "string" }, model: { type: "string" }, date: { type: "string", pattern: "^\\d{8}$" }, language: { type: "string" }, typekeys: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/Typekey" } } } },
      ResumeRequest: { type: "object", properties: { force: { type: "boolean", default: false } } },
      ResumeResponse: { type: "object", required: ["requestId", "queue"], properties: { requestId: { type: "string" }, resumedAtTypekey: { type: "string" }, queue: { type: "string", example: "bmw-extractions" } } },
      ModelOptions: { type: "object", required: ["availableFilters", "typekeys", "raw"], properties: { availableFilters: { type: "object", additionalProperties: true }, typekeys: { type: "array", items: { type: "object", additionalProperties: true } }, queryParameters: { nullable: true }, raw: { description: "Respuesta BMW completa, sin pérdida de campos", nullable: true } } },
      TypekeyProgress: { type: "object", required: ["typekey", "series", "hgs", "awSheetOIDs", "completedAwSheetOIDs", "remainingAwSheetOIDs"], properties: { typekey: { type: "string" }, series: { type: "string" }, family: { type: "string" }, model: { type: "string" }, hgs: { type: "integer" }, awSheetOIDs: { type: "integer" }, completedAwSheetOIDs: { type: "integer" }, remainingAwSheetOIDs: { type: "integer" }, failedOids: { type: "integer" } } },
      Worker: { type: "object", properties: { alive: { type: "boolean" }, concurrency: { type: "integer" }, heartbeat: { type: "string", format: "date-time", nullable: true }, ttlMs: { type: "integer", nullable: true }, queue: { type: "string" }, queueCounts: { type: "object", additionalProperties: { type: "integer" } }, activeJobs: { type: "array", items: { type: "object", properties: { requestId: { type: "string" }, typekey: { type: "string" } } } } } },
      Throughput: { type: "object", properties: { configuredRatePerSecond: { type: "integer" }, configuredJobConcurrency: { type: "integer" }, configuredAwSheetConcurrency: { type: "integer" }, windowMinutes: { type: "integer" }, requests: { type: "integer" }, permits: { type: "integer" }, permitsPerSecond: { type: "number" }, requestsPerSecond: { type: "number" }, rateLimited: { type: "integer" }, rateLimitedPercentage: { type: "number" }, completedOids: { type: "integer" }, completedOidsPerMinute: { type: "number" }, avgBmwLatencyMs: { type: "number" }, avgS3PutMs: { type: "number" }, s3Puts: { type: "integer" } } },
      JobState: { type: "object", required: ["requestId", "status", "stage", "progress"], properties: { requestId: { type: "string" }, resource: { type: "string", example: "labours" }, status: { type: "string", enum: ["queued", "downloading", "rate-limited", "paused", "completed", "failed"] }, stage: { type: "string" }, progress: { type: "integer", nullable: true }, input: { type: "object", additionalProperties: true }, extractionSummary: { type: "object", properties: { typekeys: { type: "array", items: { $ref: "#/components/schemas/TypekeyProgress" } }, date: { type: "string" }, axCode: { type: "string", nullable: true } } }, rateLimitInfo: { type: "object", nullable: true, properties: { count: { type: "integer" }, cooldownUntil: { type: "string", format: "date-time" }, retryAfterMs: { type: "integer" } } }, error: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } } },
      LabourState: { allOf: [{ $ref: "#/components/schemas/JobState" }, { type: "object", properties: { worker: { $ref: "#/components/schemas/Worker" }, throughput: { $ref: "#/components/schemas/Throughput" }, stalled: { type: "boolean", description: "Indica que el estado está activo pero no existe un job asociado en cola" } } }] },
    },
  },
} as const;
