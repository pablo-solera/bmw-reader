import { createBmwContainer } from "./composition/container.js";
import { createWorkerRuntime } from "./composition/worker-runtime.js";

const container = createBmwContainer();
await createWorkerRuntime({
  settings: container.config,
  redis: container.redis,
  objectStorage: container.objectStorage,
  rateLimiter: container.rateLimiter,
  tokenProvider: container.tokenProvider,
});
