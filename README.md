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

Configura las credenciales BMW y S3 en `.env`. En una consola ejecuta `bun run start`; en otra, `bun run worker`. API y Swagger: `http://127.0.0.1:3004` y `/docs`.

El límite BMW se comparte entre procesos por Redis y por defecto es de 3 peticiones/s. Reintenta de forma acotada los errores transitorios y respeta `Retry-After`. No registra ni expone tokens.

## API

Explora las opciones de Vehicle Type Research por niveles; `type` debe ir solo, sin los otros filtros:

```sh
curl 'http://127.0.0.1:3004/models/options?brand=BMW&language=en'
curl 'http://127.0.0.1:3004/models/options?brand=BMW&modelSeries=X%27&language=en'
curl 'http://127.0.0.1:3004/models/options?filterByType=11EH&language=en-GB'
```

Encola typekeys. AxCode/edición son opcionales y la fecha por defecto es la actual; cada typekey puede indicar un modelo propio:

```sh
curl -X POST http://127.0.0.1:3004/models -H 'content-type: application/json' -d '{"manufacturer":"BMW","date":"20260928","typekeys":[{"typekey":"11EH","family":"G70","model":"735i"},{"typekey":"11EJ","family":"G70","model":"740d"},{"typekey":"21EH","family":"G70","model":"740i"}]}'
curl http://127.0.0.1:3004/models/<requestId>
curl -L http://127.0.0.1:3004/models/<requestId>/download
```

`POST /labours` encola un solo typekey; `POST /labours/options` obtiene catálogo y HG. `/parts` y `/parts/options` devuelven 501 porque Flat Rates es una API de tiempos de trabajo.

El worker extrae catálogo, HG, inklusivpositionen y umfassttexte, y guarda las respuestas crudas en S3. Cada typekey escribe progreso por OID y un checkpoint `_progress/{typekey}/_state.json` cada 25 OID terminados; la primera reanudación de datos anteriores migra sus marcas al checkpoint mediante un listado. Los checkpoints se reescriben por lotes, por lo que una caída puede repetir como máximo las últimas 24 consultas terminadas.

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

La prueba requiere credenciales BMW y acceso de escritura al bucket configurados en `.env`. `UD42 / X5 / G05` es un ejemplo; sustituye esos argumentos por un typekey/modelo/familia confirmado para tu vehículo. `--resume` reutiliza catálogo/grupos HG ya descargados y omite awSheetOID completados; el progreso se almacena separado en `_progress/` bajo el prefijo de esa fecha.

Los endpoints awSheet se consultan para cada OID aunque el API marque `hasInklusivPositionen` / `hasUmfasstTexte` como falsos: esas marcas no son fiables en búsquedas por typekey.

Si solo quieres comprobar conectividad antes de una extracción completa: `bun run scripts/smoke-auth.ts` obtiene un token sin imprimirlo y `bun run scripts/smoke-catalog.ts UD42` consulta el catálogo y lista los grupos HG.

## Variables principales

Ver `.env.example`: `BMW_API_*`, `BMW_VEHICLE_ID_BASE_URL`, `BMW_RATE_LIMIT_PER_SEC`, `BMW_MAX_RETRIES`, `S3_*` (incluidos timeouts), `BMW_SQL_*`, `BMW_CONFIRM_PRODUCTION`, `BMW_SQL_SCHEMA_VERIFIED`, `REDIS_URL` y `BMW_CARGA_INICIAL_ROOT`.

## Comprobaciones

```sh
bun test
bun run typecheck
```
