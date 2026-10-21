/** Shared Redis-backed rate-limit adapter for BMW API requests. */
import { randomUUID } from "node:crypto";
import { RequestAbortedError, sleepWithSignal } from "reader-core/shared/retry";

export type RateLimitRedis = {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};
export type RateLimitSettings = { BMW_RATE_LIMIT_PER_SEC: number; BMW_RATE_LIMIT_MAX_COOLDOWN_MS: number; BMW_RATE_LIMIT_MIN_TIME_MS: number };

const acquireScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local priority = ARGV[3] == 'interactive' and 0 or 1
local score = priority * 10000000000000 + now
redis.call('ZADD', KEYS[5], 'NX', score, ARGV[4])
redis.call('PEXPIRE', KEYS[5], 3600000)
local first = redis.call('ZRANGE', KEYS[5], 0, 0)
if first[1] ~= ARGV[4] then return tonumber(ARGV[5]) end
local cooldown = tonumber(redis.call('GET', KEYS[1])) or now
if cooldown > now then return cooldown - now end
local capacity = tonumber(ARGV[1])
local next_at = tonumber(redis.call('GET', KEYS[4])) or now
if next_at > now then return next_at - now end
local window_start = tonumber(redis.call('GET', KEYS[2]))
local reservoir = tonumber(redis.call('GET', KEYS[3]))
if not reservoir or not window_start or now - window_start >= 1000 then
  reservoir = capacity
  window_start = now
end
if reservoir <= 0 then return math.max(1, window_start + 1000 - now) end
reservoir = reservoir - 1
redis.call('SET', KEYS[2], window_start, 'PX', 2000)
redis.call('SET', KEYS[3], reservoir, 'PX', 2000)
redis.call('SET', KEYS[4], now + tonumber(ARGV[2]), 'PX', math.max(1000, tonumber(ARGV[2]) * 4))
redis.call('ZREM', KEYS[5], ARGV[4])
return 0
`;

const releaseWaiterScript = "return redis.call('ZREM', KEYS[1], ARGV[1])";

const report429Script = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cooldown = tonumber(redis.call('GET', KEYS[1])) or now
local count = redis.call('INCR', KEYS[2])
local delay = math.min(tonumber(ARGV[1]), math.max(tonumber(ARGV[2]), tonumber(ARGV[3])))
local until_at = math.max(cooldown, now + delay)
redis.call('SET', KEYS[1], until_at, 'PX', until_at - now + tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]))
local last_log = tonumber(redis.call('GET', KEYS[3])) or 0
local should_log = 0
if now - last_log >= tonumber(ARGV[6]) then
  should_log = 1
  redis.call('SET', KEYS[3], now, 'PX', tonumber(ARGV[7]))
end
return { until_at - now, count, should_log }
`;

export function createBmwRateLimiter(client: RateLimitRedis, settings: RateLimitSettings) {
  const retryCooldownMs = (retryAfterMs = 0) => Math.min(settings.BMW_RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(500, retryAfterMs));

  return {
    async acquire(signal?: AbortSignal, priority: "interactive" | "normal" = "normal"): Promise<void> {
      const waiterId = randomUUID();
      try {
        for (;;) {
          if (signal?.aborted) throw new RequestAbortedError();
          const waitMs = Number(await client.eval(acquireScript, 5,
            "bmw-reader:rate:cooldown", "bmw-reader:rate:reservoir-at", "bmw-reader:rate:reservoir", "bmw-reader:rate:next", "bmw-reader:rate:waiters",
            settings.BMW_RATE_LIMIT_PER_SEC, settings.BMW_RATE_LIMIT_MIN_TIME_MS, priority, waiterId, 25,
          ));
          if (waitMs <= 0) return;
          await sleepWithSignal(waitMs, signal);
        }
      } catch (error) {
        await client.eval(releaseWaiterScript, 1, "bmw-reader:rate:waiters", waiterId).catch(() => undefined);
        if (signal?.aborted || error instanceof RequestAbortedError) throw new RequestAbortedError();
        throw error;
      }
    },
    async report429(retryAfterMs = 0, responseHeaders: Record<string, string> = {}) {
      const maxMs = settings.BMW_RATE_LIMIT_MAX_COOLDOWN_MS;
      const delay = retryCooldownMs(retryAfterMs);
      const result = await client.eval(report429Script, 3,
        "bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:last-log",
        maxMs, delay, retryAfterMs, maxMs, maxMs, 30000, 3600000,
      ) as [number, number, number];
      const retryAt = new Date(Date.now() + Number(result[0])).toISOString();
      if (Number(result[2]) === 1) console.warn(JSON.stringify({ event: "bmw_rate_limited", count: Number(result[1]), cooldownMs: Number(result[0]), ratePerSecond: settings.BMW_RATE_LIMIT_PER_SEC, retryAt, responseHeaders }));
      return { waitMs: Number(result[0]), count: Number(result[1]) };
    },
  };
}
