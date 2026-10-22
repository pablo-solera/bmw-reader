# API HTTP

Las rutas están bajo `/v1`; el contrato base se importa de `../reader-core`. Se sirve OpenAPI y Swagger UI localmente.

## Rutas de sistema

| Método y ruta | Comportamiento |
|---|---|
| `GET /health` | Proceso HTTP activo: `200 {"status":"ok"}`. No prueba dependencias. |
| `GET /ready` | Comprueba Redis, bucket S3 y heartbeat del worker; `200 ready` o `503 unavailable` con resultados por dependencia. |
| `GET /openapi.json` | Especificación OpenAPI combinada del contrato común y extensión BMW. |
| `GET /docs` | Swagger UI apuntando a `/openapi.json`. |

## Descubrimiento de modelos

### `GET /v1/models/options`

Parámetros query:

| Parámetro | Tipo | Default / significado |
|---|---|---|
| `manufacturer` | string opcional | Etiqueta/identificador devuelto; también funciona como brand si no se envía `brand` y no se usa `filterByType`. |
| `brand` | string opcional | Filtro de marca BMW/MINI. |
| `modelSeries` | string opcional | Serie/model series. |
| `developmentCode` | string opcional | Código de desarrollo. |
| `filterByType` | string opcional | Continúa la exploración por typekey. No se combina con marca efectiva, serie ni development code. |
| `language` | string | `en-GB`. |
| `includeRaw` | `true` / `false` | Default `false`; `true` añade la respuesta BMW sin modificar. |

`filterByType` está pensado para la consulta progresiva y se utiliza aislado de los otros filtros. La combinación inválida responde 400. El resultado incluye `manufacturer`, `appliedFilters`, `filters`, `models`, `complete` y opcionalmente `raw`. Cada modelo devuelve atributos del registro BMW y una `selection` utilizable como base para `POST /v1/labours`. Para que la selección pueda validarse, debe aportar `series` (en el query de descubrimiento o en cada typekey) y una `family` válida.

La caché Redis es de 24 horas y se separa por los parámetros normalizados. En un miss se llama a Vehicle Type Research; cualquier fallo upstream no-validación se devuelve como 502.

## Solicitudes de labour

### Crear — `POST /v1/labours`

Body común:

```json
{
  "manufacturer": "BMW",
  "axCode": "AX_1",
  "edition": "20261009",
  "language": "en-GB",
  "selection": {
    "series": "7'",
    "date": "20261009",
    "typekeys": [
      { "typekey": "11EH", "family": "G70", "model": "740i" },
      { "typekey": "21EH", "series": "7'", "family": "G70" }
    ]
  }
}
```

- `manufacturer` es obligatorio; `axCode`, `edition` y `language` son opcionales.
- `selection.typekeys` debe contener al menos un elemento.
- `typekey` debe tener exactamente cuatro caracteres `[A-Z0-9]`; `family` uno o más `[A-Z0-9]`.
- Cada typekey necesita `series` propia o `selection.series`.
- `date` es `YYYYMMDD`, opcional; si falta, se fija la fecha UTC actual.
- `model` es descriptivo. La serie se normaliza para la ruta S3: `7'` → `7`.
- No se permiten typekeys duplicados dentro del mismo request.

Validación en capas: contrato v1 común (estructura), Zod BMW (selection) y validación de dominio (fecha real, caracteres seguros, unicidad y serie normalizada). La respuesta es `202`:

```json
{
  "requestId": "<uuid>",
  "resource": "labours",
  "status": "queued",
  "links": { "self": "/v1/labours/<uuid>" }
}
```

Antes de reclamar locks o encolar, el reader pregunta a BMW por el catálogo de cada typekey (con prioridad interactiva y un máximo de 15 s). Si BMW responde `403 #CGWATB0085` para alguno, la API responde `422 NOT_AVAILABLE` sin encolar nada:

```json
{ "error": { "code": "NOT_AVAILABLE", "message": "Typekey YM13 no disponible en BMW Flat Rates (CGWATB0085)",
  "details": { "typekeys": [{ "typekey": "YM13", "code": "CGWATB0085" }] } } }
```

Si BMW no responde (límite de peticiones, caída o timeout) la comprobación no bloquea: la solicitud se encola y el worker decide. La comprobación no se repite al reanudar una solicitud existente. Una colisión con un lock de typekey o job pendiente es `409 CONFLICT`. El request nuevo no se comparte automáticamente con una solicitud anterior aunque coincidan los datos.

### Listar — `GET /v1/labours`

Query: `limit` (1–100, default 50), `cursor`, `status` (lista CSV del enum v1), `manufacturer`, `axCode` y `edition`. El cursor es opaco, codifica una posición versionada y recorre un índice Redis más nuevo primero. La respuesta es `{ "items": [...], "nextCursor": "..." | null }`. El orden no significa orden de finalización: refleja creación.

Los estados internos y públicos comparten `RequestStatus` de `reader-core`; no hay traducción BMW de estados. Los valores válidos son `queued`, `running`, `rate_limited`, `paused`, `cancelling`, `cancelled`, `completed` y `failed`.

### Estado — `GET /v1/labours/{requestId}`

`requestId` debe ser UUID. La respuesta contiene `requestId`, `resource`, `reader`, `status`, `stage`, `progress`, request reconstruido, `artifacts`, `error`, `details`, timestamps y `completedAt`. `details` añade resúmenes por typekey, worker/contadores, `stalled` y datos del cooldown.

Cada typekey publica dos artifacts: un `prefix` (no descargable como fichero único) y el fichero `{typekey}_completed.json`.

### Descargar artifact — `GET /v1/labours/{requestId}/download?artifact={nombre}`

La API devuelve una redirección 307 a una URL S3 firmada válida durante 900 segundos. Hay que indicar `artifact`; un prefijo no es una descarga individual. El marcador se puede descargar cuando exista, aunque otros typekeys del request todavía estén en proceso. Los artifacts no preparados responden `409 NOT_READY`.

### Cancelar — `POST /v1/labours/{requestId}/cancel`

Sin body. Devuelve 202 si queda `cancelling` porque el worker debe detener una operación activa; devuelve 200 si ya está `cancelled` o se pudo finalizar sin job activo. Una extracción completed no admite cancelación (409). La limpieza solo elimina prefijos incompletos que pertenecen a esa solicitud; mantiene los typekeys con marker.

### Reanudar — `POST /v1/labours/{requestId}/resume`

Body opcional `{ "force": true|false }`, default `{}`. Devuelve 202 con el typekey donde reanuda y `queue`. Se admiten requests `failed`, `paused` y `rate_limited`; un request `running` solo se reanuda si no hay job/heartbeat que demuestre actividad. `force` no se permite mientras otro worker esté activo, salvo rutas internas de recovery/shutdown. Una solicitud inexistente sin estado reanudable responde 404; una solicitud no reanudable o activa responde 409.

## Información y operaciones no soportadas

- `GET /v1/info`: versión del reader/contrato, manufacturers `BMW` y `MINI`, y capabilities. `labours` y `models.options` están habilitados.
- Operaciones `/v1/parts...`: la capability está deshabilitada y responde `501 NOT_SUPPORTED`.
- Las rutas de negocio desconocidas responden 404.

## Códigos de error relevantes

| HTTP | Código v1 | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body/query/typekey/fecha/serie/cursor inválidos o UUID mal formado. |
| 404 | `NOT_FOUND` | Request/artifact inexistente o request no existe para reanudar. |
| 422 | `NOT_AVAILABLE` | BMW no ofrece tiempos (Flat Rates) para alguno de los typekeys solicitados. |
| 409 | `CONFLICT`, `NOT_READY` | Locks o job duplicado; estado incompatible; marcador/prefijo aún no descargable. |
| 413 | `PAYLOAD_TOO_LARGE` | Body supera 64 KiB. |
| 501 | `NOT_SUPPORTED` | Funcionalidad de parts no implementada. |
| 502 | `UPSTREAM_ERROR` | Fallo de BMW Vehicle Type Research. |
| 503 | `UNAVAILABLE` | Readiness no satisfecha u otra indisponibilidad tipada. |
| 500 | `INTERNAL_ERROR` | Fallo no clasificado; no se filtra la causa interna al cliente. |

Los errores de validación, conflicto y not-found del dominio se crean tipados con `reader-core`; no se clasifican buscando frases dentro del mensaje.
