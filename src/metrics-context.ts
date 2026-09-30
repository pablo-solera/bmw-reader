import { AsyncLocalStorage } from "node:async_hooks";

export const metricRequestContext = new AsyncLocalStorage<string | undefined>();
