import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { JobState } from "../../domain/labour/job-state.js";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";

export type LabourIndexRedis = Pick<Redis, "set" | "exists" | "eval" | "zadd" | "pexpire" | "zremrangebyscore" | "zrangebyscore" | "zrevrangebyscore" | "mget" | "zrem">;

const releaseIndexLockScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export function createRedisLabourIndex(
  redis: LabourIndexRedis,
  options: { ttlMs: number; stateKey(requestId: string): string },
) {
  const bmwKey = createKeyspace("bmw-reader");
  const indexKey = bmwKey("labours", "index");
  const readyKey = bmwKey("labours", "index", "ready");

  async function initialize() {
    const lockKey = `${readyKey}:lock`;
    const token = randomUUID();
    if (await redis.set(lockKey, token, "PX", 30000, "NX") !== "OK") {
      if (await redis.exists(readyKey)) return;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await redis.exists(readyKey)) return;
      }
      throw new Error("Timed out waiting for labour request index initialization");
    }
    try {
      if (await redis.exists(readyKey)) {
        await redis.pexpire(readyKey, options.ttlMs);
        return;
      }
      const cutoff = Date.now() - options.ttlMs;
      await redis.zremrangebyscore(indexKey, "-inf", cutoff);
      const indexedIds = await redis.zrangebyscore(indexKey, cutoff, "+inf");
      const states = indexedIds.length ? await redis.mget(...indexedIds.map(options.stateKey)) : [];
      const missing = indexedIds.filter((_id, index) => states[index] === null);
      if (missing.length) await redis.zrem(indexKey, ...missing);
      await redis.set(readyKey, "1", "PX", options.ttlMs);
    } finally {
      await redis.eval(releaseIndexLockScript, 1, lockKey, token);
    }
  }

  let initialization: Promise<void> | undefined;
  function ensure() {
    initialization ??= initialize().catch(error => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }

  return {
    key: indexKey,
    ensure,
    async add(state: JobState) {
      if (state.resource !== "labours") return;
      const score = Date.parse(state.createdAt);
      if (!Number.isFinite(score)) return;
      await redis.zadd(indexKey, score, state.requestId);
      await redis.pexpire(indexKey, options.ttlMs);
    },
    async remove(requestIds: string[]) {
      if (requestIds.length) await redis.zrem(indexKey, ...requestIds);
    },
    async pruneExpired(cutoff: number) {
      await redis.zremrangebyscore(indexKey, "-inf", cutoff);
    },
    async requestIds(): Promise<string[]> {
      await ensure();
      const cutoff = Date.now() - options.ttlMs;
      await this.pruneExpired(cutoff);
      const ids = await redis.zrangebyscore(indexKey, cutoff, "+inf");
      if (!ids.length) return ids;
      const values = await redis.mget(...ids.map(options.stateKey));
      const missing = ids.filter((_id, index) => values[index] === null);
      if (missing.length) await redis.zrem(indexKey, ...missing);
      return ids;
    },
    async fetchRequestIds(cutoff: number, after: { score: number; requestId: string } | null, limit: number) {
      if (!after) return redis.zrevrangebyscore(indexKey, "+inf", cutoff, "LIMIT", 0, limit);
      if (after.score < cutoff) return [];
      const sameScore = (await redis.zrangebyscore(indexKey, after.score, after.score)).filter(id => id < after.requestId).sort().reverse();
      const tied = sameScore.slice(0, limit);
      const remaining = limit - tied.length;
      if (!remaining) return tied;
      const older = await redis.zrevrangebyscore(indexKey, `(${after.score}`, cutoff, "LIMIT", 0, remaining);
      return [...tied, ...older];
    },
  };
}
