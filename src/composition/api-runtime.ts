import { createApp } from "../app.js";
import { createParsedModelOptionsHandler } from "../interfaces/http/model-options-handler.js";
import { toBmwRequestState } from "../interfaces/http/state-mapper.js";
import type { AppDependencies } from "../interfaces/http/app-dependencies.js";
import type { JobState } from "../types.js";

export type ApiContainerDependencies = Omit<AppDependencies, "modelOptions" | "mapState"> & {
  modelOptionsGet(key: string): Promise<string | null>;
  modelOptionsSet(key: string, value: string, expiry: "EX", ttlSeconds: number): Promise<unknown>;
  objectKey(...parts: string[]): string;
  bucket: string;
  discoverModelOptions: Parameters<typeof createParsedModelOptionsHandler>[0];
  readWorkerLiveness(): Promise<unknown>;
};

export function createApiRuntime(dependencies: ApiContainerDependencies) {
  const { objectKey, bucket, discoverModelOptions, modelOptionsGet, modelOptionsSet, readWorkerLiveness, ...appPorts } = dependencies;
  const app = createApp({
    ...appPorts,
    modelOptions: createParsedModelOptionsHandler(discoverModelOptions, modelOptionsGet, modelOptionsSet),
    async mapState(value: JobState) {
      const [worker, stalled] = await Promise.all([readWorkerLiveness(), appPorts.isLabourStalled(value.requestId, value)]);
      return toBmwRequestState(value, objectKey, bucket, { worker, stalled });
    },
  });
  return app;
}
