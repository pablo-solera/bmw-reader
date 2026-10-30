import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { createKeyspace } from "@solera/core-reader/infrastructure/redis/keyspace";
import type { TypekeyLocks } from "../../application/ports/typekey-locks.js";
import { typekeyPathForJob } from "../../application/typekey-path.js";
import type { LabourInput } from "../../domain/labour/types.js";
import { ConflictError } from "@solera/core-reader/domain/errors";

export type TypekeyLockRedis = Pick<Redis, "eval" | "smembers">;

const claimScript = `
local prefix = ARGV[1] .. ':'
local token = prefix .. ARGV[2]
local ttl = tonumber(ARGV[3])
local created = {}
for i = 1, #KEYS - 1 do
  local owner = redis.call('GET', KEYS[i])
  if not owner then
    redis.call('SET', KEYS[i], token, 'EX', ttl)
    created[i] = true
  elseif string.sub(owner, 1, string.len(prefix)) == prefix then
    redis.call('EXPIRE', KEYS[i], ttl)
  else
    for j = 1, i - 1 do if created[j] then redis.call('DEL', KEYS[j]) end end
    return {0, owner}
  end
end
for i = 1, #KEYS - 1 do redis.call('SADD', KEYS[#KEYS], ARGV[i + 3]) end
redis.call('EXPIRE', KEYS[#KEYS], ttl)
return {1}
`;

const releaseScript = `
local prefix = ARGV[1] .. ':'
local count = #KEYS - 1
for i = 1, count do
  local owner = redis.call('GET', KEYS[i])
  if owner and string.sub(owner, 1, string.len(prefix)) == prefix then redis.call('DEL', KEYS[i]) end
  redis.call('SREM', KEYS[#KEYS], ARGV[i + 1])
end
if redis.call('SCARD', KEYS[#KEYS]) == 0 then redis.call('DEL', KEYS[#KEYS]) end
return 1
`;

const renewScript = `
local prefix = ARGV[1] .. ':'
local ttl = tonumber(ARGV[2])
for i = 1, #KEYS - 1 do
  local owner = redis.call('GET', KEYS[i])
  if owner and string.sub(owner, 1, string.len(prefix)) == prefix then redis.call('EXPIRE', KEYS[i], ttl) end
end
if #KEYS > 1 then redis.call('EXPIRE', KEYS[#KEYS], ttl) end
return 1
`;

export function createRedisTypekeyLocks(client: TypekeyLockRedis, bucket: string, ttlSeconds: number): TypekeyLocks {
  const bmwKey = createKeyspace("bmw-reader");
  const lockHash = (path: string) => createHash("sha256").update(`${bucket}\n${path}`).digest("hex");
  const lockKey = (hash: string) => bmwKey("typekey-lock", hash);
  const ownersKey = (requestId: string) => bmwKey("typekey-lock-owners", requestId);

  return {
    hashPath: lockHash,
    async claim(requestId: string, input: LabourInput) {
      const paths = [...new Set(input.typekeys.map((_item, index) => typekeyPathForJob(input, index)).filter((path): path is string => Boolean(path)))];
      if (!paths.length) return [];
      const hashes = paths.map(lockHash);
      const lockKeys = hashes.map(lockKey);
      const result = await client.eval(claimScript, lockKeys.length + 1, ...lockKeys, ownersKey(requestId), requestId, randomUUID(), ttlSeconds, ...hashes) as [number, string?];
      if (Number(result[0]) !== 1) {
        const owner = String(result[1] ?? "unknown");
        throw new ConflictError(`Extraction already has a queued or active job: ${owner}`, { owner });
      }
      return paths;
    },
    async release(requestId: string, paths: string[]) {
      const hashes = [...new Set(paths.map(lockHash))];
      if (!hashes.length) return;
      const lockKeys = hashes.map(lockKey);
      await client.eval(releaseScript, lockKeys.length + 1, ...lockKeys, ownersKey(requestId), requestId, ...hashes);
    },
    async renew(requestId: string) {
      const owners = ownersKey(requestId);
      const hashes = await client.smembers(owners);
      if (!hashes.length) return;
      const lockKeys = hashes.map(lockKey);
      await client.eval(renewScript, lockKeys.length + 1, ...lockKeys, owners, requestId, ttlSeconds);
    },
  };
}
