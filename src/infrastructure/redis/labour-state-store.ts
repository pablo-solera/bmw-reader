import type { Redis } from "ioredis";
import { RedisStateStore } from "reader-core/infrastructure/redis/state-store";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import { createRedisLabourIndex } from "./labour-index.js";
import type { LabourState } from "../../domain/labour/labour-state.js";

export function createRedisLabourStateStore(redis: Redis, ttlSeconds: number) {
  const labourKey = createKeyspace("bmw-reader");
  const key = (requestId: string) => labourKey("labour", requestId);
  const store = new RedisStateStore<LabourState>(redis, key, ttlSeconds);
  const index = createRedisLabourIndex(redis, { ttlMs: ttlSeconds * 1000, stateKey: key });

  return {
    key,
    index,
    get: (requestId: string) => store.get(requestId),
    async getMany(requestIds: string[]) {
      if (!requestIds.length) return [];
      const raw = await redis.mget(...requestIds.map(key));
      return raw.map(value => value ? JSON.parse(value) as LabourState : null);
    },
    async save(state: LabourState, addToIndex = false) {
      const saved = await store.set(state.requestId, state);
      if (addToIndex) await index.add(saved);
      return saved;
    },
    delete: async (requestId: string) => {
      await redis.del(key(requestId));
      await index.remove([requestId]);
    },
    async update(requestId: string, patch: Partial<LabourState>, ifMatches: Partial<LabourState> = {}) {
      const deletedKeys = Object.entries(patch).flatMap(([field, value]) => value === undefined ? [field] : []);
      const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<LabourState>;
      return store.patch(requestId, values, deletedKeys, ifMatches);
    },
  };
}
