# Redis: persistencia y coordinación

Las claves del reader usan namespace `bmw-reader`; BullMQ usa `bull:bmw-labour-typekeys:*`. TTL de estado por defecto: 604800 s (7 días). El Redis debe ser compartido por instancias API/worker de este deployment para que se cumplan locks y rate limit.

| Clave | Tipo / TTL | Función |
|---|---|---|
| `bmw-reader:labour:{requestId}` | String JSON, EX `STATE_TTL_SECONDS` | Estado `RequestStatus` de `reader-core`, entrada resumida, `queueJobId`, `typekeySummary`, progreso y error. |
| `bmw-reader:labours:index` | Sorted set, PEXPIRE asociado | Índice por timestamp de creación para listar y recuperar solicitudes. |
| `bmw-reader:labours:index:ready` | String, PEXPIRE estado | Señala que poda inicial del índice ya ocurrió. |
| `bmw-reader:labours:index:ready:lock` | String token, PX 30 s | Exclusión durante inicialización del índice. |
| `bmw-reader:labour:{id}:cancellation-requested` | String flag, EX TTL estado | Solicitud de cancelación consultada por el worker. |
| `bmw-reader:labour:{id}:heartbeat` | String runId, PX 30 s | Liveness del labour; worker renueva cada 5 s. |
| `bmw-reader:labour:{id}:cancel-cleanup-lock` | String token, PX 15 min | Evita dos limpiezas simultáneas. |
| `bmw-reader:labours:paused` | Set, expiración asociada a actividad | Solicitudes que deben reanudarse tras pausa/apagado. |
| `bmw-reader:labours:cancelling` | Set, EX TTL estado | Solicitudes cancelándose para recovery. |
| `bmw-reader:typekey-lock:{sha256}` | String owner, EX TTL estado | Lock de un path S3 por solicitud. |
| `bmw-reader:typekey-lock-owners:{requestId}` | Set hashes, EX TTL estado | Índice inverso de locks que posee una solicitud. |
| `bmw-reader:typekey-progress:{sha256}:completed` | Set OIDs, EX TTL deslizante | Checkpoints idempotentes de OIDs completos. |
| `bmw-reader:typekey-progress:{sha256}:failed` | Hash OID→mensaje, EX TTL deslizante | Fallos diferidos y reintentables dentro del typekey. |
| `bmw-reader:typekey-progress:{sha256}:meta` | Hash, EX TTL deslizante | Ruta, inicio, request, counters y marca `cancelledByRequestId`/`cancellationMessage` si falló la limpieza. |
| `bmw-reader:rate:cooldown` | String timestamp (ms), PX hasta después cooldown | Ventana compartida de 429. |
| `bmw-reader:rate:reservoir-at` / `:reservoir` | String, PX 2 s | Inicio de ventana fija de tasa y fichas restantes. |
| `bmw-reader:rate:next` | String timestamp, PX dinámico | Espaciado mínimo entre llamadas. |
| `bmw-reader:rate:429-count` | Counter, PEXPIRE 30 min | Conteo compartido de 429. |
| `bmw-reader:rate:last-log` | Timestamp, PX 1 h | Limita log de rate limit a uno cada 30 s. |
| `bmw-reader:vehicle-options:{sha256(query)}` | String JSON, EX 86400 s | Caché de descubrimiento de modelos. |
| `bmw-reader:catalog:{language}:{typekey}` | String JSON, EX 3600 s | Catálogo BMW obtenido en la comprobación previa; el worker lo reutiliza para no repetir la llamada. |
| `bmw-reader:catalog-unavailable:{language}:{typekey}` | String, EX 86400 s | Typekeys para los que BMW respondió `CGWATB0085`. |
| `bmw-reader:worker:singleton` | String token, PX 30 s | Lease de única instancia worker. |
| `bmw-reader:worker:heartbeat` | String timestamp, PX 30 s | Readiness/liveness del worker. |
| `bull:bmw-labour-typekeys:*` | Estructuras BullMQ | Cola, estados y locks internos de entrega. El nombre de job es `typekey`. |

## Atomicidad e índices

Los scripts Lua hacen atómicas las operaciones compuestas de completado de OID, actualización de contadores, lease y reservorio de tasa. `RedisStateStore.patch` de `reader-core` actualiza estado con merge atómico. Los listados consultan el índice ordenado, recortan entradas expiradas y cargan estados con MGET.

Las claves no son un mecanismo de persistencia durable de los objetos fuente: S3 es el almacenamiento de los payloads y marcadores. Al expirar el estado Redis puede dejar de ser posible listar/consultar la request aunque S3 mantenga artefactos completos.

## Compatibilidad del esquema

El estado serializado y la cola cambiaron de nombre durante el refactor. En el entorno de pruebas se descartó la base Redis local; no se migran claves antiguas `bmw-reader:job:*`, locks `active-typekey:*`, ni trabajos de `bull:bmw-extractions:*`. `FLUSHDB` solo se debe ejecutar sobre la base de pruebas seleccionada, nunca sobre Redis compartido/productivo. Los objetos S3 permanecen intactos.
