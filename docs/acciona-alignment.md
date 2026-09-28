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
9. Los checkpoints de awSheetOID se guardan en `_progress/{typekey}/_state.json`, conservando las marcas individuales para auditoría. Las marcas de extracciones anteriores se migran al checkpoint al reanudar; no se elimina ningún dato existente. Catálogo, grupos HG y manifest se retienen en memoria entre chunks del mismo proceso; al reiniciar el worker se reconstruyen desde S3 una vez. Las escrituras de payload por HG se hacen en paralelo con el límite de concurrencia configurado.
10. El limitador Redis reproduce el patrón Bottleneck del fetcher heredado: reservoir de 3 peticiones cada 1000 ms y `minTime` configurable (25 ms por defecto). Un 429 pausa por `Retry-After` o 500 ms y reintenta la llamada desde el limitador; no consume intentos BullMQ. La coordinación solo cubre instancias de `bmw-reader`, no otros servicios que compartan las credenciales BMW.
11. El lector rota por un pool configurable de tokens M2M (10 por defecto), renueva individualmente el token que recibe 401 y limita el paralelismo de consultas awSheet con `BMW_AW_SHEET_CONCURRENCY` (3 por defecto, máximo 20).
12. El worker mantiene un lock singleton y heartbeat Redis; BullMQ recupera jobs estancados y al apagado normal se completa el bloque activo antes de pausar el job.

## Limitaciones conocidas

- El DDL real de `BMW_Labour` y `DataRequestBMW` no está versionado en acciona. Verificar `INFORMATION_SCHEMA` antes de activar escrituras: algunas columnas de staging podrían tener tipos, tamaños, defaults o constraints distintos a los inferidos del VB6.
- La conexión de inspección no se pudo ejecutar en este entorno porque no se proporcionaron `BMW_SQL_SERVER`, `BMW_SQL_USER` ni `BMW_SQL_PASSWORD`. El lector deja `BMW_SQL_SCHEMA_VERIFIED=false` por defecto y bloquea cualquier escritura.
- La extracción por `dataRequestId` espera las columnas históricas `Request.ModelDesignation` y `ModelVehicle.typeKey`; el resolver se debe validar contra el esquema vivo.
- El reader crea la tabla pivote con su definición derivada de la lógica legacy. Si ya existe una tabla con ese nombre, no altera columnas existentes.
- El Excel DDA es opcional dentro de la extracción: la falta de `RegistrosQ` no deshace ni marca fallida una descarga y un pivote completados.
