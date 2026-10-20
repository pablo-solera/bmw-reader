import { createHash, randomUUID } from "node:crypto";
import { createKeyspace } from "reader-core/infrastructure/redis/keyspace";
import type { TypekeyLocks } from "../../application/ports/typekey-locks.js";
import { typekeyPathForJob } from "../../domain/labour/policies.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { ConflictError } from "reader-core/domain/errors";

export type TypekeyLockRedis = {
  set(key: string, value: string, expiry: "EX", ttlSeconds: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

const releaseScript = "local owner = redis.call('GET', KEYS[1]); if owner and string.sub(owner, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const renewScript = "local owner = redis.call('GET', KEYS[1]); if owner and string.sub(owner, 1, string.len(ARGV[1])) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end";

export function createRedisTypekeyLocks(client: TypekeyLockRedis, bucket: string, ttlSeconds: number): TypekeyLocks {
  const bmwKey = createKeyspace("bmw-reader");
  const lockHash = (path: string) => createHash("sha256").update(`${bucket}\n${path}`).digest("hex");
  const lockKey = (hash: string) => bmwKey("active-typekey", hash);
  const ownersKey = (requestId: string) => bmwKey("active-typekey-owners", requestId);

  async function releaseHashes(requestId: string, hashes: string[]) {
    await Promise.all(hashes.map(hash => client.eval(releaseScript, 1, lockKey(hash), `${requestId}:`)));
    if (hashes.length) await client.srem(ownersKey(requestId), ...hashes);
    if (!(await client.scard(ownersKey(requestId)))) await client.del(ownersKey(requestId));
  }

  return {
    hashPath: lockHash,
    async claim(requestId: string, input: LabourInput) {
      const paths = input.typekeys.map((_item, index) => typekeyPathForJob(input, index)).filter((path): path is string => Boolean(path));
      const claimed: string[] = [];
      for (const path of paths) {
        const key = lockKey(lockHash(path));
        const token = `${requestId}:${randomUUID()}`;
        const result = await client.set(key, token, "EX", ttlSeconds, "NX");
        if (result === "OK") { claimed.push(path); continue; }
        const owner = await client.get(key);
        if (owner?.startsWith(`${requestId}:`)) { claimed.push(path); continue; }
        await this.release(requestId, claimed);
        throw new ConflictError(`Extraction already has a queued or active job: ${owner ?? "unknown"}`, { owner: owner ?? "unknown" });
      }
      const hashes = claimed.map(lockHash);
      if (hashes.length) {
        await client.sadd(ownersKey(requestId), ...hashes);
        await client.expire(ownersKey(requestId), ttlSeconds);
      }
      return claimed;
    },
    async release(requestId: string, paths: string[]) {
      await releaseHashes(requestId, paths.map(lockHash));
    },
    async renew(requestId: string) {
      const owners = ownersKey(requestId);
      const hashes = await client.smembers(owners);
      await Promise.all(hashes.map(hash => client.eval(renewScript, 1, lockKey(hash), `${requestId}:`, ttlSeconds)));
      if (hashes.length) await client.expire(owners, ttlSeconds);
    },
  };
}
