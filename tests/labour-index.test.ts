import { describe, expect, test } from "bun:test";
import { createRedisLabourIndex, type LabourIndexRedis } from "../src/infrastructure/redis/labour-index.js";
import type { JobState } from "../src/domain/labour/job-state.js";

function fakeRedis(): LabourIndexRedis {
  const sorted = new Map<string, Map<string, number>>();
  const values = new Map<string, string>();
  const setFor = (key: string) => {
    const current = sorted.get(key) ?? new Map<string, number>();
    sorted.set(key, current);
    return current;
  };
  const bound = (value: string | number, isMin: boolean) => {
    const text = String(value);
    if (text === "+inf") return Number.POSITIVE_INFINITY;
    if (text === "-inf") return Number.NEGATIVE_INFINITY;
    const number = Number(text.startsWith("(") ? text.slice(1) : text);
    return text.startsWith("(") ? number + (isMin ? 0.5 : -0.5) : number;
  };
  return {
    async set(key, value, _expiry, _ttl, nx) {
      if (nx === "NX" && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async exists(key) { return Number(values.has(key)); },
    async eval(script, _keyCount, ...args) {
      const [key, token] = args.map(String);
      if (script.includes("redis.call('GET', KEYS[1])")) {
        if (values.get(key) === token) values.delete(key);
        return 1;
      }
      return 1;
    },
    async zadd(key, score, member) { const set = setFor(key); const existed = set.has(member); set.set(member, score); return Number(!existed); },
    async pexpire() { return 1; },
    async zremrangebyscore(key, min, max) {
      const set = setFor(key);
      const lower = bound(min, true), upper = bound(max, false);
      let removed = 0;
      for (const [member, score] of set) if (score >= lower && score <= upper) { set.delete(member); removed++; }
      return removed;
    },
    async zrangebyscore(key, min, max) {
      const lower = bound(min, true), upper = bound(max, false);
      return [...setFor(key)].filter(([, score]) => score >= lower && score <= upper).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member);
    },
    async zrevrangebyscore(key, max, min, _limit, offset, count) {
      const upper = bound(max, false), lower = bound(min, true);
      return [...setFor(key)].filter(([, score]) => score <= upper && score >= lower).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(Number(offset), Number(offset) + Number(count)).map(([member]) => member);
    },
    async mget(...keys) { return keys.map(key => values.get(key) ?? null); },
    async zrem(key, ...members) { const set = setFor(key); let removed = 0; for (const member of members) removed += Number(set.delete(member)); return removed; },
  };
}

function state(requestId: string, createdAt: string): JobState {
  return {
    requestId, resource: "labours", status: "queued", stage: "queued", progress: 0,
    createdAt, updatedAt: createdAt,
  };
}

describe("Redis labour index adapter", () => {
  test("initializes once, prunes dangling ids and returns indexed requests", async () => {
    const redis = fakeRedis();
    const keyFor = (id: string) => `state:${id}`;
    const index = createRedisLabourIndex(redis, { ttlMs: 60_000, stateKey: keyFor });
    const createdAt = new Date().toISOString();
    await index.add(state("present", createdAt));
    await redis.zadd(index.key, Date.now(), "missing");
    await redis.set("state:present", JSON.stringify(state("present", createdAt)), "PX", 60000);
    await index.ensure();
    await index.ensure();
    expect(await index.requestIds()).toEqual(["present"]);
  });

  test("paginates equal timestamps by stable request-id keyset", async () => {
    const redis = fakeRedis();
    const index = createRedisLabourIndex(redis, { ttlMs: 60_000, stateKey: id => `state:${id}` });
    const recent = new Date().toISOString();
    const score = Date.parse(recent);
    const older = new Date(score - 1000).toISOString();
    for (const id of ["a", "b", "c"]) await index.add(state(id, recent));
    await index.add(state("d", older));
    const first = await index.fetchRequestIds(0, null, 0, 2);
    expect(first).toEqual(["c", "b"]);
    const second = await index.fetchRequestIds(0, { score, requestId: "b" }, 0, 2);
    expect(second).toEqual(["a", "d"]);
  });
});
