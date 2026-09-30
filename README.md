# BMW Reader

Reader de tiempos BMW Aftersales (flat rates / AW), implementado con Bun, TypeScript y la API oficial de BMW. Descarga JSON crudo a S3 y ofrece endpoints para descubrir modelos/typekeys y encolar extracciones. La integración SQL legacy se mantiene separada y protegida por confirmaciones explícitas.

## Requisitos

- Bun 1.3+
- Redis 7+
- Bucket S3 compatible existente
- Acceso autorizado a BMW Aftersales Flat Rates y, si se usa integración acciona, a `BMW_Labour` / `DataRequestBMW`

## Inicio local

```powershell
Copy-Item .env.example .env
docker compose up -d redis
bun install
bun run typecheck
bun test
```

Configura las credenciales BMW y S3 en `.env`. En una consola ejecuta `bun run start`; en otra, `bun run worker`. API y Swagger: `http://127.0.0.1:3004` y `/docs`; la especificación está disponible en `/openapi.json` y declara `http://localhost:3004` como servidor local.

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

El límite BMW documentado es de 3 peticiones/s globales. `bmw-reader` lo coordina entre procesos por Redis, con reservoir, `minTime` de 25 ms y hasta 8 OID awSheet concurrentes por defecto. Cada OID usa dos peticiones BMW; una extracción activa puede alcanzar aproximadamente 90 OID/min en total al llenar el límite. `JOB_CONCURRENCY=1` asegura que los typekeys se procesen en orden, un job a la vez; `BMW_AW_SHEET_CONCURRENCY` define el paralelismo interno de OID. Se pueden ajustar para pruebas controladas, pero las credenciales se comparten con producción y su tráfico no participa en el limitador Redis; superar 3 peticiones/s puede afectar al otro consumidor. El pool configurable de access tokens (`BMW_API_TOKEN_POOL_SIZE`, 10 por defecto) rota tokens y renueva individualmente los rechazados. Los 429 respetan `Retry-After` o esperan 500 ms; no consumen reintentos BullMQ. Los errores de red y HTTP 502/503/504 se reintentan con backoff exponencial hasta `BMW_5XX_RETRY_WINDOW_MS` (10 minutos por defecto) y, agotada la ventana, el job queda para reanudación explícita. `GET /labours/:id` incluye throughput de cinco minutos por job (peticiones, 429 y OID/min); `GET /metrics/throughput` devuelve el total de la instancia. Ambos exponen latencias medias BMW/S3; el worker registra un resumen por minuto.

## API

Explora las opciones de Vehicle Type Research por niveles; `type` debe ir solo, sin los otros filtros:

```sh
curl 'http://127.0.0.1:3004/models/options?brand=BMW&language=en'
curl 'http://127.0.0.1:3004/models/options?brand=BMW&modelSeries=X%27&language=en'
curl 'http://127.0.0.1:3004/models/options?filterByType=11EH&language=en-GB'
```

Encola la extracción de uno o varios typekeys en `POST /labours`. AxCode/edición son opcionales y la fecha por defecto es la actual; cada typekey puede indicar un modelo propio:

```sh
curl -X POST http://127.0.0.1:3004/labours -H 'content-type: application/json' -d '{"manufacturer":"BMW","date":"20260928","typekeys":[{"typekey":"11EH","family":"G70","model":"735i"},{"typekey":"11EJ","family":"G70","model":"740d"},{"typekey":"21EH","family":"G70","model":"740i"}]}'
curl http://127.0.0.1:3004/labours/<requestId>
curl -X POST http://127.0.0.1:3004/labours/<requestId>/resume -H 'content-type: application/json' -d '{}'
```

`GET /models/options` consulta las opciones BMW (serie, código de desarrollo y typekeys). `/models` es solo consulta. `POST /labours` encola extracciones de uno o varios typekeys; `GET /labours/<requestId>` consulta el estado y `POST /labours/<requestId>/resume` reanuda. `/parts`, `/parts/options` y sus rutas de estado/descarga se conservan y devuelven 501 porque BMW Flat Rates todavía no implementa extracción de piezas. Las rutas `/models/:requestId`, `POST /models` y `/labours/options` se han eliminado.

El worker único (`bmw-extractions`) extrae catálogo, HG, inklusivpositionen y umfassttexte, y guarda las respuestas crudas en S3. Cada typekey es un job BullMQ único; guarda en Redis los OID completados/fallidos inmediatamente, con caducidad de siete días. Al completar escribe `{typekey}_completed.json` en la raíz del typekey y borra las claves temporales de Redis. El fichero de completado contiene ruta, contadores, tiempos, AxCode/edición y las peticiones que han reutilizado ese typekey. El catálogo, los HG y el manifest se guardan en S3 y se cargan para ese job. `S3_PREFIX` es vacío por defecto, por lo que la ruta empieza en la raíz del bucket: `BMW/{manufacturer}/labour/{model}/{family}/{YYYYMMDD}/{typekey}/`; en `.env` deja `S3_PREFIX=` vacío para usarla. En desarrollo y producción usa buckets diferentes. El proceso usa un lock/heartbeat Redis para impedir workers duplicados. Cada ejecución/reanudación usa ids de job nuevos para evitar colisiones con jobs fallidos antiguos. En una caída inesperada, BullMQ recupera el job estancado y continúa desde Redis; al apagarlo con Ctrl+C/SIGTERM, se espera el cierre ordenado hasta 75 s y el job queda pausado para reanudarse al iniciar el worker. Si se agota el retry-window de 5xx en un OID, se aparta y reintenta al final; tres fallos consecutivos detienen el typekey para proteger frente a una caída general de BMW. El evento `extraction_completed` se emite una sola vez al guardar el resumen final; `extraction_job_completed` corresponde al job de un typekey.

Consultar liveness con `GET /labours/<requestId>`; `stalled: true` señala estado activo sin job correspondiente en cola. Una extracción fallida o pausada se puede reencolar desde Redis con `POST /labours/<requestId>/resume`.

## SQL Server

`BMW_SQL_SERVER`, credenciales y bases de datos se configuran en `.env`. `BMW_CONFIRM_PRODUCTION=true` y `BMW_SQL_SCHEMA_VERIFIED=true` son obligatorios para cualquier escritura en SQL. `bun run bmw:inspect-schema` consulta solo `INFORMATION_SCHEMA` para cotejar el DDL instalado con el esquema legado antes de habilitar escrituras. No hay DDL del esquema BMW en el repositorio de acciona; las escrituras se deben validar contra la base real. En este entorno no se pudo ejecutar porque no hay host ni credenciales SQL configurados.

La carga inicial se puede inspeccionar sin escribir:

```sh
bun run bmw:carga-inicial -- "C:/ruta/a/cargaInicial"
```

El parser reconoce los JSON históricos de series, development codes y typekeys (BMW/MINI). La persistencia de ese catálogo inicial se deja deshabilitada hasta confirmar los DDL reales.

### Prueba de extracción sin SQL

Para descargar un único typekey directamente de BMW y subir los datos crudos a S3 sin consultar ni escribir en SQL:

```sh
bun run bmw:extract-s3-only -- UD42 BMW X5 G05 --resume
```

La prueba requiere credenciales BMW y acceso de escritura al bucket configurados en `.env`. `UD42 / X5 / G05` es un ejemplo; sustituye esos argumentos por un typekey/modelo/familia confirmado para tu vehículo. `--resume` reutiliza catálogo/grupos HG ya descargados y omite awSheetOID completados usando el progreso temporal de Redis; al completarse, se conserva `{typekey}_completed.json` y se eliminan las claves de progreso.

Los endpoints awSheet se consultan para cada OID aunque el API marque `hasInklusivPositionen` / `hasUmfasstTexte` como falsos: esas marcas no son fiables en búsquedas por typekey.

Si solo quieres comprobar conectividad antes de una extracción completa: `bun run scripts/smoke-auth.ts` obtiene un token sin imprimirlo y `bun run scripts/smoke-catalog.ts UD42` consulta el catálogo y lista los grupos HG.

## Variables principales

Ver `.env.example`: `HOST`, `PORT`, `REDIS_URL`, `BMW_API_*`, `BMW_VEHICLE_ID_BASE_URL`, `BMW_API_TOKEN_POOL_SIZE`, `BMW_RATE_LIMIT_*`, `BMW_AW_SHEET_*`, `BMW_5XX_RETRY_WINDOW_MS`, `S3_*` (incluidos timeouts), `BMW_SQL_*`, `BMW_CONFIRM_PRODUCTION`, `BMW_SQL_SCHEMA_VERIFIED` y `BMW_CARGA_INICIAL_ROOT`.

## Comprobaciones

```sh
bun test
bun run typecheck
```
