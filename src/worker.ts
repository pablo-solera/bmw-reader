import { createBmwContainer } from "./composition/container.js";
import { createWorkerRuntime } from "./composition/worker-runtime.js";

const container = createBmwContainer();
await createWorkerRuntime({
  redis: container.redis,
  objectStorage: container.objectStorage,
  jobs: container.jobs,
});
