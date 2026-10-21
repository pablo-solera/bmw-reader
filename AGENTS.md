# BMW Reader engineering notes

- Bun + TypeScript strict + ESM NodeNext; relative TS imports include `.js` suffixes.
- This service discovers BMW models, downloads manufacturer source files and uploads them to the established S3 layout. Keep business transformations, SQL access and report generation out of this reader. Never check credentials into the repo or log tokens.
- BMW's documented global limit is 3 req/s. `src/infrastructure/bmw/rate-limit.ts` uses a shared Redis reservoir so `bmw-reader` processes in the deployment cannot exceed the configured rate. `BMW_RATE_LIMIT_PER_SEC` may be raised experimentally only with awareness that credentials are shared with production; traffic from other applications is outside the Redis limiter.
- API inputs are validated by the shared `reader-core` v1 contract and BMW-specific Zod schemas.
- BMW API requests use `typeCode` for all four data endpoints.
- 404s are treated as empty collections. Transient retries are bounded. Preserve the raw response and API response fields, including `displayType` and every `catalogPaths` value.
- Preserve the S3 typekey layout and `{typekey}_completed.json` marker: `bmw-transformer` consumes them directly.
