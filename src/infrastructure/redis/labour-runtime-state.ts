import type { Redis } from "ioredis";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";

export function createLabourRuntimeState(redis: Redis, ttlSeconds: number, activeCancellation: Map<string, AbortController>) {
  const labourKey = createKeyspace("bmw-reader");
  const pausedKey = labourKey("labours", "paused");
  const cancellingKey = labourKey("labours", "cancelling");
  const cancellationKey = (requestId: string) => labourKey("labour", requestId, "cancellation-requested");
  const heartbeatKey = (requestId: string) => labourKey("labour", requestId, "heartbeat");

  const pausedJobs = {
    add: async (requestId: string) => { await redis.sadd(pausedKey, requestId); await redis.expire(pausedKey, ttlSeconds); },
    remove: async (requestId: string) => { await redis.srem(pausedKey, requestId); },
    list: () => redis.smembers(pausedKey),
  };
  const cancellationFlags = {
    isRequested: async (requestId: string) => Boolean(await redis.exists(cancellationKey(requestId))),
    request: async (requestId: string) => {
      await redis.set(cancellationKey(requestId), "1", "EX", ttlSeconds);
      await redis.sadd(cancellingKey, requestId);
      await redis.expire(cancellingKey, ttlSeconds);
    },
    clear: async (requestId: string) => {
      await redis.del(cancellationKey(requestId));
      await redis.srem(cancellingKey, requestId);
      activeCancellation.delete(requestId);
    },
  };
  return { pausedJobs, cancellationFlags, heartbeatKey, cancellationKey };
}
