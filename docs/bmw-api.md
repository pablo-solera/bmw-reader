# Integración BMW: autenticación, llamadas y rate limit

## API de datos

Base por defecto: `BMW_API_BASE_URL=https://apim.bmwgroup.com/aftersales/flatrates/v1`. Todas las solicitudes incluyen `language` y `typeCode`.

| Fase | Verbo y path | Query adicional | Respuesta usada |
|---|---|---|---|
| Catálogo | `GET /catalog` | `typeCode={typekey}` | Elementos cuyo `number` identifica HGs. |
| Flat rates | `GET /` | `hg={hg}&typeCode={typekey}` | `flatrateGroups` y `awSheetOID`. |
| Posiciones incluidas | `GET /inklusivpositionen/{awSheetOID}` | `typeCode={typekey}` | Datos inclusivos raw. |
| Textos cubiertos | `GET /umfassttexte/{awSheetOID}` | `typeCode={typekey}` | Textos raw. |

Las dos rutas de detalle se solicitan por OID en paralelo aunque los flags del payload indiquen falsamente que no existen. Para cada OID se escribe cada respuesta no vacía en cada HG asociado.

## Descubrimiento separado

`GET /v1/models/options` consulta `GET {BMW_VEHICLE_ID_BASE_URL}/attributes` (por defecto `https://apim.bmwgroup.com/aftersales/vehicle-identification/type-research/v1`) con los filtros de marca/serie/desarrollo/tipo. No forma parte del job de extracción, pero utiliza el mismo rate limiter, OAuth y caché Redis de 24 horas.

## OAuth y cabeceras

- Se usa OAuth client credentials con `scope=machine2machine`.
- `AccessTokenPool` mantiene hasta 10 slots en memoria por proceso, rota los slots y evita refresh duplicados concurrentes por slot.
- Las solicitudes de token se serializan con separación mínima de 250 ms.
- La vigencia local descuenta 60 s de margen, con un mínimo de 1 s.
- Los GET de datos llevan `Authorization: Bearer …`, `x-apikey` y `Accept: application/json`.
- Ante un 401 se renueva el token rechazado y se reintenta una vez.
- Los tokens y secretos no deben aparecer en logs.

El token pool no está en Redis: cada proceso tiene su pool de credenciales independiente. El rate limiter de datos sí es compartido.

## Rate limit compartido

El límite documentado global BMW es 3 solicitudes por segundo. `src/bmw/rate-limit.ts` implementa scripts Lua Redis usando `TIME` del servidor Redis:

1. Respeta un cooldown compartido por 429.
2. Aplica espacio mínimo entre solicitudes (`BMW_RATE_LIMIT_MIN_TIME_MS`, default 25 ms).
3. Consume una ficha en una ventana fija de 1 s (`BMW_RATE_LIMIT_PER_SEC`, default 3).
4. Si no hay ficha, calcula espera hasta siguiente ventana y el cliente vuelve a pedir ficha.

El límite cuenta cada intento HTTP BMW, incluidos reintentos y la repetición tras 401. No cubre clientes externos que compartan las mismas credenciales fuera de este Redis. Elevar la tasa requiere autorización y puede afectar tráfico productivo.

El procesamiento de OIDs tiene concurrencia por defecto 8 y lanza hasta dos solicitudes de detalle por OID. La concurrencia no aumenta el límite: las peticiones esperan su turno en el mismo reservorio.

## Respuestas, esperas y reintentos

| Caso | Conducta |
|---|---|
| `404` | Cancela el body y devuelve `[]`. |
| `401` | Refresca el token involucrado y repite una vez. |
| `429` | Lee `Retry-After`, notifica/cuenta el cooldown en Redis, espera y repite. Sin Retry-After, espera 500 ms. Los retries 429 no tienen límite de cantidad propio; pueden seguir durante el cooldown upstream. |
| Red/timeout | Reintentos exponenciales con jitter durante `BMW_5XX_RETRY_WINDOW_MS` (default 10 min), hasta agotar la ventana. |
| `502`, `503`, `504` | Misma ventana de retry; se respeta `Retry-After` cuando está presente. |
| Otros status no OK | `BmwApiError` no reintenta dentro del cliente. El job BullMQ todavía puede aplicar su único intento adicional, salvo errores clasificados como irrecoverable. |
| JSON inválido | Error BMW; falla la llamada. |

El timeout HTTP por intento es 10 s por defecto. Los errores de red/5xx que agotan la ventana se diferencian para que el worker evite otro retry de job inútil. Los OID con errores transitorios diferidos reciben un retry pass dentro del mismo typekey; tres fallos consecutivos detectan outage y hacen fallar ese typekey.

## Preservación del payload

Los helpers solo extraen los campos necesarios para enumerar HGs y OIDs. Cada respuesta exitosa que se guarda se persiste sin mapearla a otro esquema. Se deben conservar campos nuevos y existentes del fabricante, incluidos `displayType` y todos los valores `catalogPaths`.
