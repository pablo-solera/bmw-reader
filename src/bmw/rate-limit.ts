import { config } from "../config.js";

export type RateLimitDecision = { waitMs: number; intervalMs: number };

export function rateLimitDecision(now: number, nextAt: number, intervalMs: number, cooldownUntil: number): RateLimitDecision {
  const slot = Math.max(now, nextAt, cooldownUntil);
  return { waitMs: Math.max(0, slot - now), intervalMs };
}

export function adaptiveRate(current: number, configured: number, healthyRequests: number, recoveryRequests = 180): number {
  return healthyRequests >= recoveryRequests ? Math.min(configured, current + 1) : current;
}

export function retryCooldownMs(consecutive429s: number, retryAfterMs = 0, baseMs = 5000, maxMs = config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, consecutive429s - 1), 10));
  return Math.min(maxMs, Math.max(exponential, retryAfterMs));
}

const acquireScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local next_at = tonumber(redis.call('GET', KEYS[1])) or now
local cooldown = tonumber(redis.call('GET', KEYS[2])) or now
local interval = tonumber(ARGV[1])
local current_rate = tonumber(redis.call('GET', KEYS[3])) or tonumber(ARGV[2])
local successes = tonumber(redis.call('GET', KEYS[4])) or 0
if current_rate < tonumber(ARGV[2]) and cooldown <= now and successes >= tonumber(ARGV[3]) then
  current_rate = math.min(tonumber(ARGV[2]), current_rate + 1)
  redis.call('SET', KEYS[3], current_rate, 'PX', tonumber(ARGV[4]))
  redis.call('DEL', KEYS[4])
end
interval = math.ceil(1000 / current_rate)
local slot = math.max(now, next_at, cooldown)
redis.call('SET', KEYS[1], slot + interval, 'PX', interval * 4)
return slot - now
`;

const report429Script = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cooldown = tonumber(redis.call('GET', KEYS[1])) or now
local count = redis.call('INCR', KEYS[2])
local current_rate = tonumber(redis.call('GET', KEYS[3])) or tonumber(ARGV[6])
local reduced_rate = math.max(1, math.floor(current_rate / 2))
local delay = math.min(tonumber(ARGV[1]), tonumber(ARGV[2]) * (2 ^ math.min(count - 1, 10)))
local requested = now + math.max(delay, tonumber(ARGV[3]))
local until_at = math.max(cooldown, requested, now + tonumber(ARGV[3]))
redis.call('SET', KEYS[1], until_at, 'PX', until_at - now + tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]))
redis.call('SET', KEYS[3], reduced_rate, 'PX', tonumber(ARGV[7]))
redis.call('SET', KEYS[4], now, 'PX', tonumber(ARGV[7]))
return { until_at - now, count, reduced_rate }
`;

const clearRateLimitScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SET', KEYS[4], now, 'PX', tonumber(ARGV[1]))
return 1
`;

export async function clearBmwRateLimit(): Promise<void> {
  const { redis } = await import("../redis.js");
  await redis.eval(clearRateLimitScript, 4, "bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:current", "bmw-reader:rate:last-429", 3600000);
}

export async function reportBmw429(retryAfterMs = 0, responseHeaders: Record<string, string> = {}) {
  const { redis } = await import("../redis.js");
  const maxMs = config.BMW_RATE_LIMIT_MAX_COOLDOWN_MS;
  const minimumCooldown = retryCooldownMs(Number(await redis.get("bmw-reader:rate:429-count") ?? 0) + 1, retryAfterMs);
  const result = await redis.eval(report429Script, 4,
    "bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:current", "bmw-reader:rate:last-429",
    maxMs, 5000, retryAfterMs, minimumCooldown, maxMs, config.BMW_RATE_LIMIT_PER_SEC, 3600000,
  ) as [number, number, number];
  const headers = { retryAfterMs, retryAt: new Date(Date.now() + Number(result[0])).toISOString() };
  console.warn(JSON.stringify({ event: "bmw_rate_limited", count: Number(result[1]), cooldownMs: Number(result[0]), ratePerSecond: Number(result[2]), retryAt: headers.retryAt, responseHeaders }));
  return { waitMs: Number(result[0]), count: Number(result[1]), ratePerSecond: Number(result[2]) };
}

export async function getBmwRateState() {
  const { redis } = await import("../redis.js");
  const [cooldown, count, rate] = await redis.mget("bmw-reader:rate:cooldown", "bmw-reader:rate:429-count", "bmw-reader:rate:current");
  const configured = config.BMW_RATE_LIMIT_PER_SEC;
  const current = rate ? Number(rate) : configured;
  return { currentRate: current, cooldownUntil: cooldown ? new Date(Number(cooldown)).toISOString() : null, consecutive429s: Number(count ?? 0) };
}

export async function acquireBmwPermit(): Promise<void> {
  const { redis } = await import("../redis.js");
  const waitMs = Number(await redis.eval(acquireScript, 5,
    "bmw-reader:rate:next", "bmw-reader:rate:cooldown", "bmw-reader:rate:current", "bmw-reader:rate:success-count", "bmw-reader:rate:last-429",
    Math.ceil(1000 / config.BMW_RATE_LIMIT_PER_SEC), config.BMW_RATE_LIMIT_PER_SEC, 60000, 3600000,
  ));
  if (waitMs === 0) {
    await redis.incr("bmw-reader:rate:success-count");
    await redis.pexpire("bmw-reader:rate:success-count", 3600000);
  }
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
}

export function createLocalRateLimiter(limit = config.BMW_RATE_LIMIT_PER_SEC) {
  const permits: number[] = [];
  return async () => {
    for (;;) {
      const now = Date.now();
      while (permits.length && permits[0]! <= now - 1000) permits.shift();
      if (permits.length < limit) { permits.push(now); return; }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, permits[0]! + 1000 - now)));
    }
  };
}
