# Pruebas y comprobaciones

## Comandos

```sh
bun run typecheck
bun run test
bun run test:integration
```

- `bun run typecheck`: TypeScript `tsc --noEmit` en strict mode.
- `bun run test`: ejecuta las suites unitarias de `bun:test` descubriendo todos los `*.test.ts` de `tests/` (cualquier test nuevo se ejecuta sin tocar `package.json`); `bunfig.toml` excluye `tests/integration`.
- `bun run test:integration`: script levanta `docker-compose.test.yml` (Redis y RustFS S3 compatible en puertos loopback 16379/19000), ejecuta la suite `tests/integration` (con `bunfig.integration.toml`, que no la excluye) y limpia los servicios.
- `bun test` directamente equivale a `bun run test`: la integración queda excluida por `bunfig.toml`.

## Suites actuales

- `tests/transform.test.ts`: retry delay, parseo, concurrencia, auth pool, locks, progreso, artefactos y utilidades de dominio.
- `tests/openapi.test.ts`: inventario de rutas/OpenAPI.
- `tests/v1-http.test.ts`: capabilities, respuesta de sistema, conformance v1, validación y clasificación HTTP de errores tipados.
- `tests/worker-lock.test.ts`: lease/heartbeat y readiness.
- `tests/labour-recovery.test.ts`: recuperación de pause/orphans y cancelaciones interrumpidas.
- `tests/enqueue-labour.test.ts`: persistencia antes de queue, locks, cancelación, duplicidad y resume.
- `tests/process-labour-typekey.test.ts`: progreso, pause, liberación de locks y encadenamiento typekey.
- `tests/bmw-extraction.test.ts`: pipeline `fetchTypekey` con BMW/S3 simulados, propiedad de la marca de cancelación, reinicio por otra request, marker escrito al final, 404→colección vacía, refresh 401 y fallos transitorios.
- `tests/integration/infrastructure.test.ts`: Redis/S3 real para estados, índice, enqueue, paginación, cancelación y reanudación.

## Cobertura que debe mantenerse en mente

Las pruebas cubren el pipeline de typekey con dobles deterministas, pero no una extracción contra BMW real ni una interacción completa contra un servidor Redis real para los scripts Lua. No se debe llamar a BMW en pruebas normales. El apagado end-to-end del runtime worker sigue siendo una oportunidad de cobertura adicional. La configuración de credenciales de test debe ser exclusivamente local y nunca real.

Los errores para inputs incorrectos ahora se lanzan como `ValidationError`, `ConflictError` o `NotFoundError` de `reader-core`; sus códigos HTTP son parte del contrato y conviene probarlos por endpoint además de probar el caso de uso.
