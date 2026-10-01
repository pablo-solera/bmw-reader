import { createHash } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";

export type TypekeyProgressMeta = {
  path: string;
  startedAt: string;
  requestId: string;
  axCode: string | null;
  edition: string | null;
  language: string;
  inklusivPositionenFiles: number;
  umfasstTexteFiles: number;
};

export type TypekeyProgressStore = {
  initialize(path: string, request: { requestId: string; axCode?: string; edition?: string; language: string; forceRestart?: boolean }): Promise<TypekeyProgressMeta>;
  metadata(path: string): Promise<TypekeyProgressMeta>;
  completed(path: string): Promise<string[]>;
  failures(path: string): Promise<Record<string, string>>;
  fatalError(path: string): Promise<string | null>;
  recordCompleted(path: string, oid: string, inclusiveFiles: number, umfasstFiles: number): Promise<boolean>;
  recordFailed(path: string, oid: string, message: string): Promise<void>;
  recordIncompleteFailure(path: string, message: string): Promise<void>;
  recordIncompleteFailure(path: string, message: string): Promise<void>;
  clear(path: string): Promise<void>;
};

export type TypekeyProgressRedis = {
  get(key: string): Promise<string | null>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hset(key: string, ...fieldValues: Array<string | Record<string, string>>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
};

export function typekeyProgressKeys(path: string) {
  const id = createHash("sha256").update(`${config.S3_BUCKET}\n${path}`).digest("hex");
  const prefix = `bmw-reader:typekey-progress:${id}`;
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

export class RedisTypekeyProgressStore implements TypekeyProgressStore {
  constructor(private readonly client: TypekeyProgressRedis = redis as unknown as TypekeyProgressRedis, private readonly ttlSeconds = config.STATE_TTL_SECONDS) {}

  async initialize(path: string, request: { requestId: string; axCode?: string; edition?: string; language: string; forceRestart?: boolean }): Promise<TypekeyProgressMeta> {
    const keys = typekeyProgressKeys(path);
    if (request.forceRestart) await this.client.hdel(keys.meta, "fatalError");
    const startedAt = new Date().toISOString();
    await this.client.hsetnx(keys.meta, "startedAt", startedAt);
    await this.client.hset(keys.meta, {
      path,
    });
    await this.client.hsetnx(keys.meta, "requestId", request.requestId);
    await this.client.hsetnx(keys.meta, "axCode", request.axCode ?? "");
    await this.client.hsetnx(keys.meta, "edition", request.edition ?? "");
    await this.client.hsetnx(keys.meta, "language", request.language);
    await this.client.hsetnx(keys.meta, "inklusivPositionenFiles", "0");
    await this.client.hsetnx(keys.meta, "umfasstTexteFiles", "0");
    await this.touch(keys);
    return this.metadata(path);
  }

  async metadata(path: string): Promise<TypekeyProgressMeta> {
    const keys = typekeyProgressKeys(path);
    const values = await this.client.hgetall(keys.meta);
    await this.touch(keys);
    const startedAt = values.startedAt ?? new Date().toISOString();
    return {
      path: values.path ?? path,
      startedAt: values.startedAt ?? startedAt,
      requestId: values.requestId ?? "",
      axCode: values.axCode || null,
      edition: values.edition || null,
      language: values.language ?? config.BMW_API_LANGUAGE,
      inklusivPositionenFiles: Number(values.inklusivPositionenFiles ?? 0),
      umfasstTexteFiles: Number(values.umfasstTexteFiles ?? 0),
    };
  }

  async completed(path: string) {
    const keys = typekeyProgressKeys(path);
    const values = await this.client.smembers(keys.completed);
    await this.touch(keys);
    return values;
  }

  async failures(path: string) {
    const keys = typekeyProgressKeys(path);
    const values = await this.client.hgetall(keys.failed);
    await this.touch(keys);
    return values;
  }

  async fatalError(path: string) {
    const keys = typekeyProgressKeys(path);
    const value = await this.client.hgetall(keys.meta);
    await this.touch(keys);
    return value.fatalError ?? null;
  }

  async recordCompleted(path: string, oid: string, inclusiveFiles: number, umfasstFiles: number) {
    const keys = typekeyProgressKeys(path);
    const inserted = Number(await this.client.eval(recordCompletedScript, 3, keys.completed, keys.failed, keys.meta, oid, inclusiveFiles, umfasstFiles, this.ttlSeconds));
    return inserted === 1;
  }

  async recordFailed(path: string, oid: string, message: string) {
    const keys = typekeyProgressKeys(path);
    await this.client.hset(keys.failed, oid, message);
    await this.touch(keys);
  }

  async recordIncompleteFailure(path: string, message: string) {
    const keys = typekeyProgressKeys(path);
    await this.client.hset(keys.meta, "fatalError", message);
    await this.touch(keys);
  }

  async clear(path: string) {
    const keys = typekeyProgressKeys(path);
    await this.client.del(keys.completed, keys.failed, keys.meta);
  }

  private async touch(keys: ReturnType<typeof typekeyProgressKeys>) {
    await this.client.expire(keys.completed, this.ttlSeconds);
    await this.client.expire(keys.failed, this.ttlSeconds);
    await this.client.expire(keys.meta, this.ttlSeconds);
  }
}

export const typekeyProgressStore = new RedisTypekeyProgressStore();

export type TypekeyCompletedRequest = { requestId: string; axCode: string | null; edition: string | null; at: string; reused: boolean };
export type TypekeyCompletedMarker = {
  schemaVersion: 1;
  path: string;
  group: string;
  manufacturer: string;
  series: string;
  model: string;
  family: string;
  typekey: string;
  date: string;
  hgs: number;
  awSheetOIDs: number;
  inklusivPositionenFiles: number;
  umfasstTexteFiles: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  language: string;
  requestId: string;
  axCode: string | null;
  edition: string | null;
  requests: TypekeyCompletedRequest[];
};

export function addCompletedRequest(marker: TypekeyCompletedMarker, request: TypekeyCompletedRequest): TypekeyCompletedMarker {
  const requests = marker.requests ?? [];
  if (requests.some(existing => existing.requestId === request.requestId)) return marker;
  return { ...marker, requests: [...requests, request] };
}
