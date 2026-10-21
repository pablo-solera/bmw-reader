# Flujo de extracción completo

## 1. Entrada y creación de request

El cliente puede descubrir filtros en `GET /v1/models/options`, construir una selection y llamar a `POST /v1/labours`. El router común valida el contrato v1; la capa BMW valida `selection`; el dominio vuelve a comprobar rutas/fecha/typekeys y normaliza la serie.

La API genera un UUID de request. La operación de enqueue:

1. identifica typekeys todavía no completados;
2. construye para cada uno el path `BMW/{manufacturer}/labour/{series}/{family}/{date}/{typekey}`;
3. reclama un lock por path, derivado de SHA-256(bucket + newline + path), con `SET NX` y TTL de `STATE_TTL_SECONDS`;
4. persiste el estado `queued` y lo agrega al índice Redis;
5. añade el job inicial con ID `{requestId}--{runId}--{index}` y opciones explícitas (dos intentos totales, backoff exponencial nativo de BullMQ de 30 s antes del único reintento).

La API añade solo el primer job. Cada job se ocupa de un typekey y al finalizar crea el siguiente, por lo que una selección de varios typekeys avanza secuencialmente dentro de la request. Los locks impiden que otra request escriba simultáneamente en la misma ruta.

## 2. Arranque y coordinación del worker

El worker comprueba S3, adquiere el lock singleton Redis de 30 s y publica heartbeat; renueva ambos cada 10 s. El Worker BullMQ tiene concurrencia 1, `lockDuration` 60 s, comprobación de stalls cada 15 s y hasta 100 recuperaciones de stalled count.

Después de crear el Worker, inicializa/limpia el índice de labours, finaliza cancelaciones huérfanas y reencola requests pausados o sin job activo. Estas recuperaciones de dominio se ejecutan al arrancar. BullMQ mantiene además su propia recuperación de jobs stalled.

Cada job refresca un heartbeat por request cada 5 s, renueva los locks de typekey y consulta el flag cancel. Durante llamadas BMW, el cliente y las esperas de rate limit aceptan AbortSignal.

## 3. Reutilización y preparación

`fetchTypekey` calcula el prefijo S3 y revisa primero `{typekey}_completed.json`:

- Si existe, actualiza el array `requests` del marker con `reused: true`, limpia progress temporal y no consulta BMW.
- Si hay una marca `cancelledByRequestId` en progress y pertenece a la misma request, rechaza la continuación. Si pertenece a otra request, borra el prefijo incompleto y los checkpoints antes de reiniciar. La marca guarda la identidad de quien canceló, incluso si antes otra request había inicializado el checkpoint.
- Si puede reanudar, reutiliza catalog/flat rates guardados en S3 y los OIDs completos registrados en Redis.

## 4. Llamadas BMW y objetos S3

1. **Catalog:** `GET /catalog?typeCode={typekey}`; guarda `{typekey}_catalog.json` en raw JSON y deriva los HG.
2. **Flat rates:** una consulta por HG, `GET /?hg={hg}&typeCode={typekey}`; guarda `{hg}/{typekey}_{hg}.json` sin transformar.
3. **Manifiesto:** construye un mapa de `awSheetOID` a sus HG sin duplicados y guarda `{typekey}_awSheetOIDsAndGroups.json` si no existía.
4. **Detalles de OID:** para cada OID pendiente ejecuta en paralelo `inklusivpositionen/{oid}` y `umfassttexte/{oid}`, ambos con `typeCode`. Guarda respuestas raw no vacías bajo las carpetas HG asociadas.
5. **Checkpoint:** al completar un OID, inserta idempotentemente su ID en el set Redis y actualiza contadores. Las fallas OID se guardan por separado.
6. **Completion marker:** solo si todos los OIDs se completaron, construye el marker compacto y lo escribe al final. Después borra progress Redis temporal.

Un 404 de BMW cuenta como colección vacía. Una respuesta detalle vacía o que no sea array no crea el fichero de ese detalle. Un typekey con cero OIDs puede completarse con marker de cero objetos de detalle.

## 5. Progreso, resultado y encadenamiento

Los callbacks de progreso guardan resúmenes (HGs, OIDs, completos, restantes y fallidos), `stage` y porcentaje en el estado Redis. Al completar el typekey, el caso de uso libera su lock:

- si quedan typekeys, actualiza `queueJobId` y encola el siguiente index;
- si es el último, marca el labour `completed`, `progress: 100`, guarda los resúmenes finales y libera los locks restantes.

No hay un objeto global de request en S3. El marker por typekey es la fuente durable de completitud. El estado detallado del request vive en Redis y expira según el TTL configurado.

## 6. Fallos y datos parciales

- Error no irrecuperable: BullMQ ejecuta hasta un segundo intento después de 30 s.
- Fallos por ventana de red/5xx agotada y fallos de OID se clasifican como no recuperables por el caso de uso; no reciben el reintento BullMQ.
- Los objetos ya escritos se mantienen ante error o pausa. El marker no se crea, así que el consumidor posterior no debe tratar ese prefijo como completo.
- Un retry/resume aprovecha archivos S3 y checkpoints Redis para evitar repetir trabajo terminado.
- La cancelación elimina los prefijos incompletos pertenecientes a la solicitud, limpia checkpoints y conserva datos completos.

## 7. Recursos generados

```text
[S3_PREFIX/]BMW/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/
  {typekey}_catalog.json
  {typekey}_awSheetOIDsAndGroups.json
  {typekey}_completed.json
  {hg}/{typekey}_{hg}.json
  {hg}/{oid}_inklusivpositionen.json
  {hg}/{oid}_umfassttexte.json
```

Los ficheros de detalle son condicionales a recibir un array no vacío. `S3_PREFIX` se antepone si está configurado. El detalle normativo está en [Contrato S3](s3-contract.md).
