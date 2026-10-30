# BMW Reader

Reader de tiempos BMW Aftersales (flat rates / AW), implementado con Bun, TypeScript y la API oficial de BMW. Descubre modelos, descarga los ficheros crudos del fabricante y los sube al layout S3 acordado. El contrato HTTP v1 se comparte desde `../reader-core`.

La [documentación detallada del proyecto](docs/README.md) describe la arquitectura, la API, el proceso de extracción, la persistencia Redis/S3, la operación y las pruebas.

## Requisitos

- Bun 1.4+
- Redis 7+
- Bucket S3 compatible existente
- Acceso autorizado a BMW Aftersales Flat Rates

## Inicio local

```powershell
Copy-Item .env.example .env
docker compose up -d redis
bun install
bun run typecheck
bun test
```

Configura las credenciales BMW y S3 en `.env`. En una consola ejecuta `bun run start`; en otra, `bun run worker`. API y Swagger: `http://127.0.0.1:3004` y `/docs`; las rutas de negocio usan el prefijo `/v1`.

## Despliegue con Docker Compose

API y worker se despliegan simultáneamente como servicios separados construidos desde la misma imagen. Redis guarda los jobs/estados y conserva su cola en el volumen `redis-data`.

```sh
cp .env.example .env
# completa las credenciales BMW y S3 en .env
docker compose up -d --build
docker compose ps
docker compose logs -f api worker
```

La API queda publicada en `http://localhost:3004`; el worker no publica puertos. Mantén una sola réplica del servicio `worker`: el lock Redis rechaza workers duplicados deliberadamente. Para actualizar, ejecuta `docker compose up -d --build`; para parar, `docker compose down`. Los datos de Redis permanecen en el volumen nombrado. El `.env` se inyecta al ejecutar los contenedores y está excluido del contexto de build.

Para correr solo Redis y desarrollar API/worker directamente en el host, `docker compose up -d redis` sigue disponible; usa en ese caso `REDIS_URL=redis://127.0.0.1:6379`.

BMW limita la API a 3 peticiones/s. El reader coordina el límite entre procesos por Redis y rota un pool de access tokens. Cada OID usa dos peticiones BMW; el máximo teórico es de unos 90 OID/min. Los 429 respetan `Retry-After` o esperan 500 ms; los errores de red y HTTP 502/503/504 se reintentan con backoff hasta `BMW_5XX_RETRY_WINDOW_MS` y, agotada la ventana, el request queda disponible para reanudación.

## API

El estado de `GET /v1/labours/<requestId>` enumera prefijos y marcadores de completitud en `artifacts[]`. `GET /v1/labours/<requestId>/download?artifact=21EH_completed.json` firma la descarga del marcador. Sin `artifact`, BMW responde `NOT_READY` porque no crea un fichero principal único; los prefijos se leen directamente desde S3. `/v1/info` publica capabilities y `/ready` comprueba Redis, S3 y el heartbeat del worker; si el heartbeat falta o ha caducado, responde HTTP 503 con `worker: "error"`.

Explore BMW Vehicle Type Research progressively; `filterByType` must be used without `modelSeries` or `developmentCode`:

```sh
curl 'http://127.0.0.1:3004/v1/models/options?manufacturer=BMW&brand=BMW&language=en'
curl 'http://127.0.0.1:3004/v1/models/options?manufacturer=BMW&brand=BMW&modelSeries=X%27&language=en'
curl 'http://127.0.0.1:3004/v1/models/options?manufacturer=BMW&filterByType=11EH&language=en-GB'
```

The response normalizes BMW `availableFilters` and `typekeys` into `filters` and `models`. Set `includeRaw=true` to include the unmodified BMW response. The OpenAPI documentation groups operations by `System`, `Info`, `Labours`, `Parts`, and `Models`; route summaries and descriptions are in English.

Queue an extraction for one or more typekeys with `POST /v1/labours`. AxCode and edition are optional; the extraction date defaults to today. Provide a series in `selection` or on each typekey; `model` is descriptive:

```sh
curl -X POST http://127.0.0.1:3004/v1/labours -H 'content-type: application/json' -d '{"manufacturer":"BMW","selection":{"date":"20260928","series":"7'"'"'","typekeys":[{"typekey":"11EH","family":"G70","model":"735i"},{"typekey":"11EJ","family":"G70","model":"740d"},{"typekey":"21EH","family":"G70","model":"740i"}]}}'
curl http://127.0.0.1:3004/v1/labours/<requestId>
curl -X POST http://127.0.0.1:3004/v1/labours/<requestId>/resume -H 'content-type: application/json' -d '{}'
```

`GET /v1/models/options` discovers BMW model series, development codes, and typekeys. `POST /v1/labours` queues an extraction; `GET /v1/labours/<requestId>` returns its status; and `POST /v1/labours/<requestId>/resume` resumes it. BMW does not support parts extraction, so parts operations return 501.

`GET /v1/labours` returns cursor-paginated requests retained in Redis for up to seven days. It supports `status`, `manufacturer`, `axCode`, and `edition` filters. Cancel a request with `POST /v1/labours/<requestId>/cancel`; the response may report `cancelling` while an in-flight OID is stopped, then transitions to `cancelled`. Incomplete, unshared typekey prefixes are removed from S3; completed and shared data is preserved.

The single worker (`bmw-labour-typekeys`) downloads the catalog, HG flat rates, inklusivpositionen, and umfassttexte, and stores the raw responses in S3. Each typekey is a BullMQ job. Completed and failed OID checkpoints are stored in Redis with a seven-day TTL. On completion, the worker writes `{typekey}_completed.json` in the typekey root and clears temporary Redis checkpoints. The request state exposes typekey prefixes and completion markers in `artifacts[]`; `?artifact=<typekey>_completed.json` redirects to a marker, while a prefix cannot be downloaded as a single file. The S3 layout remains `BMW/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/`, which `bmw-transformer` consumes directly. `details.worker` contains the heartbeat and queue counts; `details.stalled` checks the saved `queueJobId` rather than scanning the queue.

Check service readiness with `GET /ready`, which probes Redis, S3, and the worker heartbeat and returns HTTP 503 if any check fails. An orderly worker shutdown clears its heartbeat immediately; after a crash, the heartbeat expires within 30 seconds. `GET /v1/labours/<requestId>` also exposes `details.stalled`, determined by looking up the associated job. Failed or paused extractions can be requeued with `POST /v1/labours/<requestId>/resume`.

The awSheet endpoints are queried for each OID even if BMW reports `hasInklusivPositionen` / `hasUmfasstTexte` as false; those flags are not reliable in typekey searches.

## Variables principales

Ver `.env.example`: `HOST`, `PORT`, `REDIS_URL`, `BMW_API_*`, `BMW_VEHICLE_ID_BASE_URL`, `BMW_API_TOKEN_POOL_SIZE`, `BMW_RATE_LIMIT_*`, `BMW_AW_SHEET_CONCURRENCY`, `BMW_5XX_RETRY_WINDOW_MS` y `S3_*`.

Los workers reclaman locks Redis por prefijo S3 de typekey para impedir extracciones simultáneas del mismo conjunto de ficheros. Los locks se renuevan con el heartbeat del worker y se liberan al terminar cada typekey. `GET /v1/labours` pagina desde el índice Redis; consulta individual y cancelación/resume usan `queueJobId`, sin leer todos los jobs de la cola. Los estados internos usan `RequestStatus` de `@solera/core-reader`; el resumen por typekey se persiste como `typekeySummary` y `progress` conserva el porcentaje genérico.

Los `GET /v1/models/options` de la API persisten su resultado en Redis durante 24 horas por fabricante y filtros, para no repetir consultas de descubrimiento idénticas.

## Comprobaciones

```sh
bun test
bun run typecheck
```
