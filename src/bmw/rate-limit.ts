import { config } from "../config.js";
import { redis } from "../redis.js";

const retryCooldownMs = (retryAfterMs = 0, retryDelayMs = 500, maxMs = config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS): number => Math.min(maxMs, Math.max(retryDelayMs, retryAfterMs));

// Redis-backed Bottleneck equivalent: reservoir refreshes every second, with a
// minimum spacing between requests and a shared cooldown after upstream 429s.
const acquireScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
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
return 0
`;

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

export async function reportBmw429(retryAfterMs = 0, responseHeaders: Record<string, string> = {}) {
  const maxMs = config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS;
  const delay = retryCooldownMs(retryAfterMs, 500, maxMs);
  const result = await redis.eval(report429Script, 3,
    "bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:last-log",
    maxMs, delay, retryAfterMs, maxMs, maxMs, 30000, 3600000,
  ) as [number, number, number];
  const retryAt = new Date(Date.now() + Number(result[0])).toISOString();
  if (Number(result[2]) === 1) console.warn(JSON.stringify({ event: "bmw_rate_limited", count: Number(result[1]), cooldownMs: Number(result[0]), ratePerSecond: config.BMW_RATE_LIMIT_PER_SEC, retryAt, responseHeaders }));
  return { waitMs: Number(result[0]), count: Number(result[1]), ratePerSecond: config.BMW_RATE_LIMIT_PER_SEC };
}

export async function acquireBmwPermit(signal?: AbortSignal): Promise<void> {
  for (;;) {
    const waitMs = Number(await redis.eval(acquireScript, 4,
      "bmw-reader:rate:cooldown", "bmw-reader:rate:reservoir-at", "bmw-reader:rate:reservoir", "bmw-reader:rate:next",
      config.BMW_RATE_LIMIT_PER_SEC, config.BMW_RATE_LIMIT_MIN_TIME_MS,
    ));
    if (waitMs <= 0) return;
    if (signal?.aborted) throw new Error("BMW request cancelled");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, waitMs);
      function done() { signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("BMW request cancelled")); }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
