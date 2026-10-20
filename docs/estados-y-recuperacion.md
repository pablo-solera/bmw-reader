# Estados, cancelación y recuperación

## Estado observable

La API v1 expone `queued`, `running`, `rate_limited`, `paused`, `cancelling`, `cancelled`, `completed` y `failed`. El estado interno usa `downloading` y `rate-limited`; el mapper traduce esos dos a nombres del contrato común.

```text
queued → downloading ⇄ rate-limited → completed
              ├→ queued (retry BullMQ) → downloading
              ├→ failed
              ├→ paused (apagado) → queued (resume/recovery)
              └→ cancelling → cancelled
```

`stage` aporta detalle como `{typekey}:preparing`, `{typekey}:catalog`, `{typekey}:aw-sheet-details`, `{typekey}:rate-limited`, `{typekey}:retrying`, `{typekey}:paused`, `completed` o `cancelled`. `progress` del request alcanza 100 solo al completar el último typekey. El estado de typekey también registra cantidad total/completa/restante y errores de OID.

## Reintentos y fallos

- Configuración de job: `attempts: 2` (dos ejecuciones en total) y backoff exponencial BullMQ de 30 s (un único intervalo con dos intentos).
- Errores no irrecuperables: marcan `queued` antes de retry y `failed` cuando ya no hay intentos.
- Fallos de OID o ventana transitoria agotada se convierten en `UnrecoverableError`, por lo que BullMQ no repite ese job.
- El evento de fallo ahora identifica `UnrecoverableError` explícitamente; `willRetry` no se determina comparando un nombre de error original que llega envuelto.
- Jobs stalled: BullMQ revisa cada 15 s; si el lock del job desaparece puede volver a entregar el job, hasta `maxStalledCount: 100`.

La backoffStrategy custom anterior fue eliminada porque no se invocaba: los jobs usan el tipo built-in `exponential` de BullMQ, cuyo delay queda definido en las opciones del job.

## Pausa por apagado

Ante `SIGINT`, `SIGTERM` o `beforeExit`, el worker deja de tomar jobs nuevos y solicita pausa. En el bucle de OIDs, `shouldStop` deja de iniciar trabajo, devuelve progreso/checkpoints y el request pasa a `paused`, registrado en `bmw-reader:paused-jobs`. Las fases de catalog y flat rates que ya hayan empezado pueden completar; las llamadas HTTP en vuelo no se abortan solo por shutdown.

El proceso espera hasta 75 s por cierre ordenado. Docker Compose permite 90 s antes de terminar el contenedor. Si se agota el tiempo, se deja expirar el lease singleton para que BullMQ recupere el trabajo stalled.

## Cancelación

1. API marca `bmw-reader:job:{id}:cancel`, añade el ID a `bmw-reader:cancelling-jobs` y cambia estado a `cancelling`.
2. Si el job está activo, el worker detecta el flag en su polling de 5 s y aborta esperas/peticiones compatibles con AbortSignal.
3. Si no está activo, se intenta eliminar el job waiting/delayed/failed y finalizar de inmediato; se comprueba de nuevo por carrera con un job que se haya activado.
4. Una limpieza serializada por lock examina marcadores. Preserva typekeys completados y borra de S3 prefijos incompletos que esta solicitud posee.
5. Se liberan locks, se marcan checkpoints fatales donde la limpieza no fue segura y se completa como `cancelled`.

Una cancelación no borra artefactos completados. Un marker existente se trata como garantía de completitud por typekey.

## Resume y recovery al arrancar

`POST /resume` crea `runId` y BullMQ job ID nuevos. Selecciona el primer typekey incompleto y reclama locks pendientes. `fetchTypekey` consulta marker/checkpoints y reutiliza S3/Redis. No se reanuda una solicitud cancelada/cancelling.

En el arranque del worker:

- se recorren solicitudes `cancelling` sin job activo para completar la cancelación;
- se recorren IDs pausados y solicitudes indexadas `downloading`, `queued`, `rate-limited` o `paused`; si no hay job pending se intenta reanudarlas;
- errores individuales de recovery se registran y no detienen el recorrido de los demás requests.

Esta recovery de dominio corre una vez por inicio, no como proceso periódico. BullMQ dispone de su recuperación independiente de stalled jobs.

## Worker liveness y stalled

El lease `bmw-reader:worker:singleton` y heartbeat `bmw-reader:worker:heartbeat` tienen TTL 30 s y se renuevan cada 10 s. `/ready` falla si el TTL no es positivo. El heartbeat de request vive 30 s y se renueva cada 5 s. `details.stalled` se calcula si no hay heartbeat reciente y el job guardado no está activo/waiting/delayed (o no existe).
