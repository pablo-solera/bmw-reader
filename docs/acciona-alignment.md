# Alineación con acciona (BMW)

## Flujo que se porta

El VB6 activo (`BMW_API2.frm` + `API_BMW.bas`) llamaba al servicio interno `bmw-api-fetcher`, que a su vez llamaba a BMW y subía archivos a S3. Acciona guardaba `Peticiones`, importaba el espejo SMB de `S3_path`, llenaba `typekeyCatalog` y `typekeyIdEntriesId`, generaba `<AxCode>_<Edicion>`/`nomCamposTabla` y comparaba con `RegistrosQ`.

Este reader llama a la API BMW directamente con client credentials, `Bearer` + `x-apikey`, guarda el payload crudo en S3, crea las tablas staging legacy y deriva el pivote y el Excel DDA. El layout de datos descargados conserva `{group}/{manufacturer}/labour/{model}/{family}/{YYYYMMDD}/{typekey}/{typekey}_catalog.json` y los ficheros por HG y awSheetOID.

El flujo actual de extracción a S3 se encola por `POST /models` y no ejecuta escrituras SQL. `GET /models/options` expone Vehicle Type Research para explorar marca, serie, development code y typekeys. El AxCode no es necesario para la extracción cruda; si no se proporciona, el nombre del resumen usa `without-axcode`. `POST /labours` y `POST /models` comparten una única cola y un solo worker.

## Reglas portadas

- Un catálogo por typekey y `typeCode`; las llamadas por HG conservan la lista completa de `catalogPaths`.
- Los awSheetOID se deduplican para hacer una consulta de inklusivpositionen y umfassttexte por OID y se relacionan con cada HG de origen.
- `workType`: `HAUPTARBEIT` → `T.P.`, `VERBUNDARBEIT` → `T.A.`, `PLUSARBEIT` → `P.P`, `SONSTIGE_VERBUNDARBEIT` → `O.T.A.`. Se conserva el sufijo de equipamiento especial.
- Comparación DDA: operación exacta; si contiene `)` aplica la regla inclusiva DDA >= BMW; si contiene `ZAX`, marca si existe valor BMW. `KN` no se informa.

## Diferencias intencionadas respecto al VB6

1. El fichero de catálogo se guarda y se lee bajo el typekey solicitado, no bajo `baseType` (el fetcher nombra el directorio por typekey).
2. Se conservan todos los `catalogPaths`; no se pierde la relación salvo la última ruta.
3. `displayType` y los campos opcionales no se descartan.
4. El pivote agrupa por la clave de catálogo más los datos de flatrate, incluido `workType`, `klammerText`, `awSheetOID`, número y ruta. No arrastra estado entre entradas ni crea filas semilla huérfanas.
5. Las relaciones de ruta se resuelven en memoria, no con `LIKE` sobre IDs que contienen `%` o `_`.
6. El código SA se extrae de `validityExpression` con patrón, no con desplazamiento fijo.
7. DDA nunca se borra automáticamente después del informe.
8. No se copian ficheros a `\\10.33.144.77\Fabricantes`: S3 es la fuente. La carga inicial solo se analiza (dry-run) hasta confirmar el esquema real.
9. Cada typekey se ejecuta como un único job BullMQ. El progreso temporal (OID completados, OID fallidos y metadatos/contadores) se mantiene en claves Redis identificadas por bucket y ruta de typekey, con TTL renovable de siete días. Cada OID se registra al terminar sus escrituras S3; no se reescribe un checkpoint JSON periódico ni se crean objetos temporales en S3. Al terminar se escribe `{typekey}_completed.json` en la raíz del typekey y se eliminan las claves Redis. El marcador permanente conserva `schemaVersion`, ruta relativa, grupo, fabricante, modelo, familia, typekey, fecha, contadores, tiempos, idioma, requestId, AxCode/edición y una lista deduplicada de peticiones que reutilizan el typekey. Catálogo, grupos HG y manifest se cargan desde S3 al comenzar el job; las escrituras de payload por HG se hacen en paralelo con el límite configurado.
10. El limitador Redis reproduce el patrón Bottleneck del fetcher heredado: reservoir de 3 peticiones cada 1000 ms y `minTime` configurable (25 ms por defecto). Un 429 pausa por `Retry-After` o 500 ms y reintenta la llamada desde el limitador; no consume intentos BullMQ. La coordinación solo cubre instancias de `bmw-reader`, no otros servicios que compartan las credenciales BMW.
11. El lector rota por un pool configurable de tokens M2M (10 por defecto), renueva individualmente el token que recibe 401 y limita el paralelismo de consultas awSheet con `BMW_AW_SHEET_CONCURRENCY` (8 por defecto, máximo 20). `JOB_CONCURRENCY=1` fuerza ejecución typekey a typekey. Cada OID genera dos peticiones; el limitador global permanece en 3 req/s, para un máximo teórico cercano a 90 OID/min. El registro de métricas se agrupa en pipelines Redis no bloqueantes.
12. El worker mantiene un lock singleton y heartbeat Redis; procesa un job a la vez y cada job cubre un typekey completo. BullMQ recupera jobs estancados; al apagar, los nuevos OID dejan de iniciarse y el trabajo en curso termina; los OID listos ya están guardados en Redis. Los ids incluyen un UUID de ejecución para evitar colisiones entre reanudaciones y jobs fallidos retenidos. Al arrancar, el worker busca extracciones activas sin jobs vivos y las reanuda; `GET /models/{requestId}` expone `stalled` para esos estados.
13. Los errores de red y HTTP 502/503/504 usan un backoff exponencial con jitter y ventana máxima `BMW_5XX_RETRY_WINDOW_MS` (10 minutos por defecto). Si un OID agota la ventana se difiere y reintenta una vez al final; tres fallos consecutivos detienen el typekey para proteger frente a un fallo sistémico BMW. Los 429 siguen su ruta de cooldown y no consumen reintentos de job. `extraction_completed` solo representa el fin de la extracción completa; el fin del job por typekey se registra como `extraction_job_completed`.

## Limitaciones conocidas

- El DDL real de `BMW_Labour` y `DataRequestBMW` no está versionado en acciona. Verificar `INFORMATION_SCHEMA` antes de activar escrituras: algunas columnas de staging podrían tener tipos, tamaños, defaults o constraints distintos a los inferidos del VB6.
- La conexión de inspección no se pudo ejecutar en este entorno porque no se proporcionaron `BMW_SQL_SERVER`, `BMW_SQL_USER` ni `BMW_SQL_PASSWORD`. El lector deja `BMW_SQL_SCHEMA_VERIFIED=false` por defecto y bloquea cualquier escritura.
- La extracción por `dataRequestId` espera las columnas históricas `Request.ModelDesignation` y `ModelVehicle.typeKey`; el resolver se debe validar contra el esquema vivo.
- El reader crea la tabla pivote con su definición derivada de la lógica legacy. Si ya existe una tabla con ese nombre, no altera columnas existentes.
- El Excel DDA es opcional dentro de la extracción: la falta de `RegistrosQ` no deshace ni marca fallida una descarga y un pivote completados.
- `S3_PREFIX` es vacío por defecto; las rutas se escriben desde la raíz del bucket como `BMW/{manufacturer}/labour/{model}/{family}/{YYYYMMDD}/{typekey}/`. Los buckets de desarrollo y producción son distintos. La persistencia del progreso depende de la persistencia/retención de Redis; si se pierde Redis antes de completar, el typekey se repite y sus respuestas se sobrescriben en S3.
