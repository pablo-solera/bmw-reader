# Documentación de BMW Reader

`bmw-reader` descubre selecciones de vehículos BMW/MINI, acepta solicitudes de descarga de tiempos Aftersales, consulta la API oficial de BMW y guarda las respuestas originales en el layout S3 que consume `bmw-transformer`. No transforma los tiempos a tablas de negocio, no accede a SQL y no genera informes.

## Guía

| Documento | Contenido |
|---|---|
| [Arquitectura](arquitectura.md) | Tecnologías, procesos, módulos y dependencias. |
| [API HTTP](api.md) | Rutas, contratos, validación, respuestas y errores. |
| [Flujo de extracción](flujo-extraccion.md) | Recorrido desde el POST hasta la marca de completitud por typekey. |
| [API BMW, autenticación y límites](bmw-api.md) | Endpoints, tokens, rate limit, reintentos y concurrencia. |
| [Estados, cancelación y recuperación](estados-y-recuperacion.md) | Máquina de estados y comportamiento ante fallo o apagado. |
| [Redis](redis.md) | Claves, tipos de datos y TTL. |
| [Contrato S3](s3-contract.md) | Layout, objetos generados y significado del marcador. |
| [Configuración](configuracion.md) | Variables de entorno, defaults y restricciones. |
| [Operación](operacion.md) | Inicio local, Docker Compose, readiness, logs y apagado. |
| [Pruebas](testing.md) | Suites, comandos, cobertura y límites conocidos. |

## Diagramas interactivos

Los HTML son artefactos autónomos generados y validados con Archify. Ábrelos en un navegador para explorar las relaciones.

Los HTML y sus JSON se regeneran junto con este refactor desde el código de la revisión actual. Cada especificación incluye evidencia enlazada a los módulos reales de `src/`.

- [Flujo de una extracción](diagrams/flujo-extraccion.html)
- [Arquitectura](diagrams/arquitectura.html)
- [Ciclo de vida de una solicitud](diagrams/ciclo-solicitud.html)
- [Secuencia de llamadas BMW por typekey](diagrams/secuencia-bmw.html)

Los ficheros JSON contiguos a cada HTML son las especificaciones fuente de los diagramas.

## Vocabulario

- **typekey / typeCode:** código BMW de cuatro caracteres que identifica una variante de tipo de vehículo para los endpoints de datos.
- **HG:** grupo de trabajo empleado por las respuestas de flat rates y por el layout de S3.
- **AW sheet / AW sheet OID:** identificador de una hoja de trabajo al que se consultan los endpoints de inclusivpositionen y umfassttexte.
- **request / labour:** extracción solicitada a través de la API pública; contiene uno o varios typekeys.
- **job:** unidad BullMQ de procesamiento de un typekey. Los typekeys de una misma request se encadenan secuencialmente.
- **completion marker:** objeto `{typekey}_completed.json`, escrito al acabar satisfactoriamente todos los OIDs de ese typekey. Su existencia es el contrato que usa `bmw-transformer` para considerar que los objetos están completos.

## Alcance y contrato de datos

El reader conserva los payloads BMW en bruto, incluyendo campos desconocidos y valores como `displayType` y `catalogPaths`. El consumidor posterior lee las claves `BMW/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/...`; el detalle se documenta en [Contrato S3](s3-contract.md). Los nombres del grupo raíz y del marcador son interfaces entre proyectos y no deben cambiarse sin coordinar `bmw-transformer`.
