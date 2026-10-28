# Operación y despliegue

## Docker Compose

`docker-compose.yml` levanta Redis, API y worker. API y worker usan la misma imagen multi-stage y `.env`; Redis usa AOF y volumen nombrado `redis-data`. El build requiere un contexto adicional `reader_core: ../reader-core`, ya que la dependencia es local. La API publica 3004 y tiene healthcheck `/health`. El worker no publica puertos, usa `redis://redis:6379` y tiene `stop_grace_period: 90s`.

```sh
cp .env.example .env
# Configura BMW y S3 en .env sin versionarlo
docker compose up -d --build
docker compose ps
docker compose logs -f api worker
```

Debe mantenerse una réplica del worker. El lock en Redis rechaza otra instancia activa, y la concurrencia del worker es fija en 1 (`JOB_CONCURRENCY` en `jobs-runtime.ts`, no configurable). Para parar: `docker compose down`; el volumen Redis se conserva. Para desarrollo con API/worker en host, levanta solo Redis y usa su URL de loopback.

## Health y readiness

- `/health` confirma que el servidor HTTP responde; no prueba dependencias.
- `/ready` prueba ping Redis, `HeadBucket` S3 y expiración positiva del heartbeat worker. Sin worker activo, readiness devuelve 503 aunque el proceso API esté sano.
- El contenedor API usa `/health` como Docker healthcheck. Monitorización de servicio debe revisar también `/ready`.
- S3 se comprueba al inicio de API y worker. `S3_AUTO_CREATE_BUCKET=true` permite creación únicamente cuando el acceso resulta en 404; errores de permisos/no disponibilidad no se convierten en creación.

## Logs

La mayoría de eventos de proceso se emiten como JSON por stdout/stderr. Algunos eventos útiles: `worker_ready`, `worker_shutdown_started`, `worker_shutdown_complete`, `worker_singleton_lock_lost`, `typekey_started`, `typekey_progress`, `typekey_completed`, `typekey_attempt_failed`, `typekey_failed`, `extraction_completed`, `extraction_cancelled`, `extraction_paused`, `bmw_rate_limited`, `s3_operation_slow` y `extraction_stalled_recovered`.

Los logs no deben incluir bearer tokens, secretos OAuth, API keys ni credenciales S3. Los errores BMW pueden incluir texto de respuesta truncado a 300 caracteres; revisar que los mensajes upstream no contengan datos que la política operacional prohíba registrar.

## Apagado

El worker maneja `SIGINT`/`SIGTERM`, pausa el worker y espera hasta 75 s por trabajos activos. Al cierre ordenado limpia heartbeat y libera lease singleton; tras apagado forzado deja expirar el lease para que el mecanismo de recuperación no tome posesión demasiado pronto. Compose concede 90 s antes de SIGKILL.

## Diagnóstico rápido

| Síntoma | Comprobación |
|---|---|
| `/ready` 503 | Revisar Redis, acceso/endpoint/bucket S3 y `bmw-reader:worker:heartbeat`. |
| API arriba pero jobs pendientes | Confirmar servicio worker único y logs de recovery/errores; inspeccionar BullMQ counts de `details.worker`. |
| `details.stalled=true` | Revisar el job `queueJobId`, heartbeat de labour y logs de stalled recovery. |
| 429/cooldown | Consultar evento `bmw_rate_limited`, `Retry-After` y valor configurado de rate. No elevar el límite como primera solución. |
| Request failed con objetos parciales | Comprobar ausencia de marker; reanudar para usar checkpoints o investigar el error BMW/S3. |
| No se puede descargar prefix | Comportamiento esperado: pedir un artifact de archivo, típicamente `{typekey}_completed.json`. |

## Seguridad y límites del componente

Credenciales solo en entorno/secret manager. Mantener `S3_PREFIX` y los permisos mínimos de bucket. Redis controla jobs, leases y rate limit, por lo que todos los procesos deben apuntar al mismo Redis. La limitación compartida solo cubre procesos conectados a este Redis, no otras aplicaciones que usen las mismas credenciales BMW.

## Reinicio de estado Redis en entorno de pruebas

Los cambios de esquema `queueJobId`/`typekeySummary`, estados `RequestStatus`, namespace `bmw-reader:labour:*` y cola `bmw-labour-typekeys` son incompatibles con los datos antiguos. En el entorno local de pruebas es seguro borrar la base seleccionada de Redis antes de desplegar este refactor:

```sh
docker compose exec -T redis redis-cli FLUSHDB
```

**No ejecutes este comando en un Redis compartido o productivo.** Elimina jobs, estado, locks, caché y checkpoints Redis; no borra los objetos S3.
