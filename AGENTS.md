# BMW Reader engineering notes

- Bun + TypeScript strict + ESM NodeNext; relative TS imports include `.js` suffixes.
- Keep BMW API transformations pure and test them with synthetic payloads. Never check credentials into the repo or log tokens.
- BMW's documented global limit is 3 req/s. `src/bmw/rate-limit.ts` uses a shared Redis reservoir so `bmw-reader` processes in the deployment cannot exceed the configured rate. `BMW_RATE_LIMIT_PER_SEC` may be raised experimentally only with awareness that credentials are shared with production; traffic from other applications is outside the Redis limiter.
- API inputs are validated. SQL values must be parameterized; identifiers must pass `quoteIdentifier()`.
- `BMW_CONFIRM_PRODUCTION=true` gates every SQL write. Inspect live schema before changing SQL mappings.
- The BMW Aftersales API's successful production contract uses `typeCode` for the four endpoints, although the published OpenAPI spec inconsistently documents `typekey` on catalog and flatrates.
- 404s are treated as empty collections. Transient retries are bounded. Preserve the raw response and API response fields, including `displayType` and every `catalogPaths` value.
- `acciona` stores source catalogue rows in `typekeyCatalog`, labour rows in `typekeyIdEntriesId`, special detail payloads in `LoRaro`, and comparison columns in `<AxCode>_<Edicion>` plus `nomCamposTabla`.
- Document behavior changes versus legacy VB6 in `docs/acciona-alignment.md`; do not silently preserve known lossy/merging behavior.
