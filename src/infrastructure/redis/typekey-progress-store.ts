import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { createKeyspace } from "@solera/core-reader/infrastructure/redis/keyspace";
import type { TypekeyCancellationMarker, TypekeyProgressMeta, TypekeyProgressStore } from "../../application/ports/typekey-progress-store.js";
export type { TypekeyCancellationMarker, TypekeyProgressMeta, TypekeyProgressStore } from "../../application/ports/typekey-progress-store.js";

const progressKey = createKeyspace("bmw-reader:typekey-progress");

export type TypekeyProgressRedis = Pick<Redis, "eval" | "del">;

export function typekeyProgressKeys(path: string, bucket: string) {
  const id = createHash("sha256").update(`${bucket}\n${path}`).digest("hex");
  const prefix = progressKey(id);
  return { completed: `${prefix}:completed`, failed: `${prefix}:failed`, meta: `${prefix}:meta` };
}
const recordCompletedScript = `
local inserted = redis.call('SADD', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
if inserted == 1 then
  redis.call('HINCRBY', KEYS[3], 'inklusivPositionenFiles', tonumber(ARGV[2]))
  redis.call('HINCRBY', KEYS[3], 'umfasstTexteFiles', tonumber(ARGV[3]))
end
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[4])) end
return inserted
`;

const initializeScript = `
if ARGV[5] == '1' then redis.call('HDEL', KEYS[3], 'cancelledByRequestId', 'cancellationMessage') end
redis.call('HSETNX', KEYS[3], 'startedAt', ARGV[1])
redis.call('HSET', KEYS[3], 'path', ARGV[2])
redis.call('HSET', KEYS[3], 'requestId', ARGV[3])
redis.call('HSETNX', KEYS[3], 'axCode', ARGV[4])
redis.call('HSETNX', KEYS[3], 'edition', ARGV[6])
redis.call('HSETNX', KEYS[3], 'language', ARGV[7])
redis.call('HSETNX', KEYS[3], 'inklusivPositionenFiles', '0')
redis.call('HSETNX', KEYS[3], 'umfasstTexteFiles', '0')
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[8])) end
return 1
`;

const readMetaScript = "for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1])) end; return redis.call('HGETALL', KEYS[3])";
const readCompletedScript = "for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1])) end; return redis.call('SMEMBERS', KEYS[1])";
const readFailuresScript = "for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1])) end; return redis.call('HGETALL', KEYS[2])";
const readCancellationMarkerScript = "for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1])) end; return {redis.call('HGET', KEYS[3], 'cancelledByRequestId') or '', redis.call('HGET', KEYS[3], 'cancellationMessage') or ''}";
const recordFailureScript = "redis.call('HSET', KEYS[2], ARGV[1], ARGV[2]); for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[3])) end; return 1";
const recordCancellationMarkerScript = "redis.call('HSET', KEYS[3], 'requestId', ARGV[1], 'cancelledByRequestId', ARGV[1], 'cancellationMessage', ARGV[2]); for i = 1, 3 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[3])) end; return 1";

export class RedisTypekeyProgressStore implements TypekeyProgressStore {
  constructor(private readonly client: TypekeyProgressRedis, private readonly ttlSeconds: number, private readonly bucket: string, private readonly defaultLanguage: string) {}

  async initialize(path: string, request: { requestId: string; axCode?: string; edition?: string; language: string; forceRestart?: boolean }): Promise<TypekeyProgressMeta> {
    const keys = typekeyProgressKeys(path, this.bucket);
    const startedAt = new Date().toISOString();
    await this.client.eval(initializeScript, 3, keys.completed, keys.failed, keys.meta, startedAt, path, request.requestId, request.axCode ?? "", request.edition ?? "", request.language, request.forceRestart ? "1" : "0", this.ttlSeconds);
    return this.metadata(path);
  }

  async metadata(path: string): Promise<TypekeyProgressMeta> {
    const keys = typekeyProgressKeys(path, this.bucket);
    const values = pairsToRecord(await this.client.eval(readMetaScript, 3, keys.completed, keys.failed, keys.meta, this.ttlSeconds));
    return {
      path: values.path ?? path,
      startedAt: values.startedAt ?? new Date().toISOString(),
      requestId: values.requestId ?? "",
      axCode: values.axCode || null,
      edition: values.edition || null,
      language: values.language ?? this.defaultLanguage,
      inklusivPositionenFiles: Number(values.inklusivPositionenFiles ?? 0),
      umfasstTexteFiles: Number(values.umfasstTexteFiles ?? 0),
    };
  }

  async completed(path: string) {
    const keys = typekeyProgressKeys(path, this.bucket);
    return await this.client.eval(readCompletedScript, 3, keys.completed, keys.failed, keys.meta, this.ttlSeconds) as string[];
  }

  async failures(path: string) {
    const keys = typekeyProgressKeys(path, this.bucket);
    return pairsToRecord(await this.client.eval(readFailuresScript, 3, keys.completed, keys.failed, keys.meta, this.ttlSeconds));
  }

  async cancellationMarker(path: string): Promise<TypekeyCancellationMarker | null> {
    const keys = typekeyProgressKeys(path, this.bucket);
    const value = await this.client.eval(readCancellationMarkerScript, 3, keys.completed, keys.failed, keys.meta, this.ttlSeconds);
    const [cancelledByRequestId, message] = Array.isArray(value) ? value.map(String) : [];
    return cancelledByRequestId && message ? { cancelledByRequestId, message } : null;
  }

  async recordCompleted(path: string, oid: string, inclusiveFiles: number, umfasstFiles: number) {
    const keys = typekeyProgressKeys(path, this.bucket);
    const inserted = Number(await this.client.eval(recordCompletedScript, 3, keys.completed, keys.failed, keys.meta, oid, inclusiveFiles, umfasstFiles, this.ttlSeconds));
    return inserted === 1;
  }

  async recordFailed(path: string, oid: string, message: string) {
    const keys = typekeyProgressKeys(path, this.bucket);
    await this.client.eval(recordFailureScript, 3, keys.completed, keys.failed, keys.meta, oid, message, this.ttlSeconds);
  }

  async recordIncompleteFailure(path: string, requestId: string, message: string) {
    const keys = typekeyProgressKeys(path, this.bucket);
    await this.client.eval(recordCancellationMarkerScript, 3, keys.completed, keys.failed, keys.meta, requestId, message, this.ttlSeconds);
  }

  async clear(path: string) {
    const keys = typekeyProgressKeys(path, this.bucket);
    await this.client.del(keys.completed, keys.failed, keys.meta);
  }
}

function pairsToRecord(value: unknown): Record<string, string> {
  const pairs = Array.isArray(value) ? value : [];
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < pairs.length; index += 2) result[String(pairs[index])] = String(pairs[index + 1]);
  return result;
}
