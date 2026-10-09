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

## API

Las rutas de negocio están bajo `/v1` y usan el contrato común de `../reader-core`. La respuesta de estado enumera cada prefijo y marcador en `artifacts`; un prefijo no es descargable como un único archivo. La API permite descargar un marcador mediante `GET /v1/labours/{requestId}/download?artifact={typekey}_completed.json`.
