# Arquitectura y tecnologías

## Responsabilidad

El servicio es un reader de extracción. Descubre filtros/modelos, valida y encola peticiones, llama a BMW Aftersales y copia los datos recibidos a S3. Redis coordina cola, estado, checkpoints, locks y el límite de peticiones. Las transformaciones de negocio pertenecen a `bmw-transformer`, no a este proyecto.

## Stack

| Área | Tecnología | Uso |
|---|---|---|
| Runtime y gestor | Bun 1.4.x | Ejecuta API, worker, tests y scripts. |
| Lenguaje | TypeScript strict, ESM / NodeNext | Código tipado; imports relativos con sufijo `.js`. |
| HTTP | Express 5 | Rutas de sistema y API v1. |
| Contrato y OpenAPI | `@pablosla/core-reader` local + Zod 4 | Esquemas v1, manejo de errores, routers, OpenAPI y helpers compartidos. |
| Trabajo asíncrono | BullMQ 6 | Cola Redis `bmw-labour-typekeys`; un job por typekey. |
| Estado/coord. | Redis + ioredis 6 | Estado de solicitudes, indexación, locks, progress y rate limiter Lua. |
| Validación | Zod | Variables de entorno, selección BMW y parámetros de discovery. |
| Almacenamiento | AWS SDK v3 S3 + `@pablosla/core-reader` S3Store | Objetos JSON en S3 o almacenamiento compatible. |
| Tests | `bun:test` | Unit tests e integración real con Redis y RustFS. |
| Contenedores | Docker multi-stage y Docker Compose | API y worker separados, misma imagen. |

No hay framework de lint/format configurado. La comprobación estática principal es `bun run typecheck`.

## Procesos de ejecución

### API (`src/index.ts`)

1. `createBmwContainer()` carga y valida configuración y construye clientes compartidos.
2. Comprueba/accede al bucket S3 antes de escuchar.
3. Arranca Express en `HOST:PORT` (por defecto `127.0.0.1:3004`; en contenedor se configura `0.0.0.0`).
4. La API encola trabajo, consulta estado y expone descubrimiento. No procesa extracciones.

### Worker (`src/worker.ts`)

1. Usa el mismo composition root y Redis.
2. Comprueba el bucket y toma el lease Redis `bmw-reader:worker:singleton`; si ya pertenece a otro proceso, falla al arrancar.
3. Mantiene lock y heartbeat mientras consume BullMQ con concurrencia 1.
4. Recupera cancelaciones incompletas y solicitudes huérfanas al inicio.
5. Ejecuta los jobs, escribe datos en S3 y actualiza estado/checkpoints.

El límite de concurrencia 1 es deliberado y está validado por configuración. Los procesos API pueden escalar, pero el limitador BMW es compartido en Redis. El servicio worker se debe ejecutar con una sola réplica.

## Capas y módulos

- `src/interfaces/http/`: contratos HTTP BMW, esquemas Zod/OpenAPI, mapeo de estado y handlers.
- `src/app.ts`: conecta las rutas comunes de `@pablosla/core-reader` a los casos de uso BMW.
- `src/application/use-cases/`: enqueue, cancelación, listado, reanudación, recuperación, descarga de artefactos y procesamiento por typekey.
- `src/application/ports/`: puertos de cola, API BMW, S3 de artefactos, progreso y locks; los casos de uso no conocen ioredis ni BullMQ.
- `src/domain/labour/`: `LabourState` usa directamente `RequestStatus` de `@pablosla/core-reader`; `queueJobId` referencia BullMQ y `typekeySummary` guarda el resumen por typekey.
- `src/application/bmw/parse.ts`: normalización defensiva de catálogos, HGs y tarifas de BMW.
- `src/infrastructure/bmw/`: autenticación, cliente HTTP, discovery y limitador compartido.
- `src/infrastructure/redis/`: almacenamiento e índice de labour, señales runtime, progreso, locks y cliente Redis.
- `src/infrastructure/s3/`: adaptador S3, archivado y borrado de prefijos por lotes.
- `src/infrastructure/bullmq/`: adaptador de cola labour y opciones de job.
- `src/composition/`: container, API/worker runtime y processor typekey, que conectan casos de uso y adaptadores.
- `@pablosla/core-reader` (repositorio `core-reader`, publicado en npmjs): contrato v1, router Express, errores tipados, OpenAPI, BullMQ, S3Store, locks Redis y utilidades compartidas.

## Camino principal y responsabilidad de cada sistema

```text
Cliente HTTP → API Express → validación → estado/lock Redis → BullMQ
                                              ↓                   ↓
                                           Redis        Worker → BMW API
                                                           ↓
                                                     objetos y marker S3
```

- La **API** es dueña de aceptación y control administrativo; solo encola el primer typekey.
- **BullMQ** entrega cada job y conserva su estado de ejecución. El estado de dominio que ve la API se mantiene además como JSON propio en Redis.
- El **worker** controla llamadas BMW, checkpoints y escrituras S3.
- **BMW** es la fuente de los payloads. Las respuestas JSON se guardan sin transformaciones de negocio.
- **S3** es el contrato durable entre reader y transformer.
- **Redis** evita solapamientos de rutas de typekey y comparte el límite global de solicitudes BMW entre procesos del servicio.

## Contratos externos que se deben preservar

1. Contrato HTTP v1 de `@pablosla/core-reader`; errores de validación, conflicto, not-found y upstream se expresan con `ApplicationError` tipado.
2. Todas las cuatro llamadas de datos BMW incluyen el parámetro `typeCode`.
3. Se conserva el payload original del fabricante.
4. Se mantiene el layout S3 y el marker `{typekey}_completed.json`.
5. No se introducen SQL, transformaciones tabulares ni generación de informes en este reader.

Más detalle: [API](api.md), [Flujo](flujo-extraccion.md), [S3](s3-contract.md) y [Operación](operacion.md).
