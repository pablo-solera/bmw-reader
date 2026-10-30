# Contrato de extracción BMW a S3

`bmw-reader` solo descarga payloads de BMW Aftersales y los almacena en S3. No conecta a SQL, no transforma los tiempos a tablas de negocio y no genera informes.

## Layout preservado

El prefijo relativo sigue siendo:

```text
{group}/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/
  {typekey}_catalog.json
  {typekey}_awSheetOIDsAndGroups.json
  {typekey}_completed.json
  {hg}/{typekey}_{hg}.json
  {hg}/{oid}_inklusivpositionen.json
  {hg}/{oid}_umfassttexte.json
```

`S3_PREFIX`, cuando se configura, se antepone a esas claves. Series como `7'` se normalizan a `7`, como antes. No se cambian las formas JSON del fabricante ni el marcador de completitud.

`bmw-transformer` consume los objetos directamente desde S3 y usa la presencia de `{typekey}_completed.json` para identificar extracciones completas. No comparte cola ni claves Redis con el reader.

## Significado de cada objeto

- `{typekey}_catalog.json`: respuesta original de `/catalog`.
- `{hg}/{typekey}_{hg}.json`: respuesta original de flat rates para el HG.
- `{typekey}_awSheetOIDsAndGroups.json`: índice derivado `OID → groups`; no sustituye el payload de BMW.
- `{hg}/{oid}_inklusivpositionen.json` y `{hg}/{oid}_umfassttexte.json`: respuestas crudas no vacías para ese OID y HG. Un 404/array vacío no crea objeto.
- `{typekey}_completed.json`: marker compacto que se escribe después de completar todos los OIDs y objetos. No se escribe en una extracción fallida o pausada. Un typekey sin OIDs puede completarse con counts en cero.

El marker contiene `schemaVersion`, path relativo, grupo/manufacturer/serie/model/family/typekey/date, counts de HG/OID/ficheros, timestamps, duración, idioma, request ID, axCode/edition y un historial `requests[]` de solicitudes que crearon o reutilizaron ese typekey. La presencia del marker es la señal que consume el transformer; no basta que existan archivos parciales.

## Escritura, reanudación y limpieza

Los JSON de respuestas/manifiesto se escriben con formato legible; el marker se escribe compacto. Las respuestas del fabricante no se normalizan ni se eliminan campos. Los checkpoints de OID viven temporalmente en Redis y se limpian tras escribir el marker. Al reanudar, los archivos de catálogo/flat rates y los OIDs completados permiten continuar sin repetir trabajo ya persistido.

Un fallo o pausa conserva lo que ya se escribió, pero deja el prefijo sin marker. La cancelación puede borrar solo rutas incompletas reclamadas por esa solicitud y conserva typekeys que ya tengan marker. `deletePrefix` valida que el target corresponda a una ruta typekey BMW válida antes de borrar.

## API

Las rutas de negocio están bajo `/v1` y usan el contrato común de `@pablosla/core-reader`. La respuesta de estado enumera cada prefijo y marcador en `artifacts`; un prefijo no es descargable como un único archivo. La API permite descargar un marcador mediante `GET /v1/labours/{requestId}/download?artifact={typekey}_completed.json`.
