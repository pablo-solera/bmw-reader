# Configuración

`src/config.ts` valida variables con Zod al construir el container. Los valores vacíos de `S3_ENDPOINT` se tratan como no definidos. `.env.example` es la plantilla; no se deben añadir credenciales reales al repositorio ni imprimir tokens/secretos.

| Variable | Default | Límite / notas |
|---|---|---|
| `HOST` | `127.0.0.1` | En contenedor: `0.0.0.0`. |
| `PORT` | `3004` | Entero positivo. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | En Compose los servicios usan `redis://redis:6379`. |
| `STATE_TTL_SECONDS` | `604800` | Entero positivo; estado y locks de typekey. |
| `JOB_CONCURRENCY` | `1` | Entero positivo con máximo validado 1. |
| `BMW_API_ACCESS_TOKEN_URL` | `https://auth.bmwgroup.com/auth/oauth2/machine2machine/access_token` | URL OAuth. |
| `BMW_API_CLIENT_ID` | vacío | Credencial requerida para uso BMW. |
| `BMW_API_CLIENT_SECRET` | vacío | Secreto; no loguearlo. |
| `BMW_API_KEY` | vacío | API key requerida; no loguearla. |
| `BMW_API_BASE_URL` | `https://apim.bmwgroup.com/aftersales/flatrates/v1` | API Flat Rates. |
| `BMW_VEHICLE_ID_BASE_URL` | `https://apim.bmwgroup.com/aftersales/vehicle-identification/type-research/v1` | Vehicle Type Research. |
| `BMW_API_TIMEOUT_MS` | `10000` | Timeout por llamada de BMW y token. |
| `BMW_MODEL_OPTIONS_RATE_LIMIT_WAIT_MS` | `2000` | Máximo que `/v1/models/options` espera por el limitador compartido antes de responder 503. |
| `BMW_API_TOKEN_POOL_SIZE` | `10` | Entero 1–10. Pool en memoria por proceso. |
| `BMW_API_LANGUAGE` | `en-GB` | Idioma por defecto de solicitudes. |
| `BMW_RATE_LIMIT_PER_SEC` | `3` | Entero 1–20; el límite documentado de BMW es 3/s. No elevar sin evaluar credenciales/tráfico compartido. |
| `BMW_RATE_LIMIT_MAX_COOLDOWN_MS` | `1800000` | Máximo de cooldown: 30 min. |
| `BMW_RATE_LIMIT_MIN_TIME_MS` | `25` | Mínima separación aplicada por script Redis. |
| `BMW_AW_SHEET_CONCURRENCY` | `8` | Entero 1–20; OIDs en paralelo, no altera el rate limit. |
| `BMW_5XX_RETRY_WINDOW_MS` | `600000` | Ventana máxima de reintentos de red/5xx: 10 min. |
| `S3_ENDPOINT` | vacío / AWS por SDK | URL opcional para S3 compatible. |
| `S3_REGION` | `us-east-1` | Región AWS. |
| `S3_ACCESS_KEY` | vacío | Si ambas claves S3 están vacías, AWS SDK usa la cadena de credenciales por defecto. |
| `S3_SECRET_ACCESS_KEY` | vacío | Secreto S3. |
| `S3_BUCKET` | `magnets-reader-dev` | Bucket. |
| `S3_PREFIX` | vacío | Prefijo opcional antepuesto al layout. |
| `S3_FORCE_PATH_STYLE` | `true` | Solo `true` o `false`; se traduce a boolean de AWS SDK. |
| `S3_AUTO_CREATE_BUCKET` | `false` | Solo `true` o `false`; solo crea bucket si el acceso devuelve 404. |

## Ajustes fijos en código

No son variables de entorno: caché model options 86400 s; lock/heartbeat worker 30000 ms renovado cada 10000 ms; heartbeat labour 30000 ms actualizado cada 5000 ms; lock de cleanup 15 min; rate reservoir por segundo; máximo de payload HTTP 64 KiB; S3 timeout 30 s, SDK adaptive retry con `maxAttempts: 5`; URL presignada 900 s; BullMQ `attempts: 2`, backoff exponencial de 30000 ms, `lockDuration: 60000`, `stalledInterval: 15000`, `maxStalledCount: 100`; espera máxima de apagado worker 75000 ms. La cola es `bmw-labour-typekeys` y los jobs se llaman `typekey`.

## Inicio local

1. Copiar `.env.example` a `.env` y completar credenciales localmente.
2. Levantar Redis (`docker compose up -d redis`) y garantizar acceso al bucket.
3. Ejecutar API y worker en procesos separados: `bun run start` y `bun run worker`.

No compartir secretos en tickets/logs y no versionar `.env`.
