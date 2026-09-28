import { config } from "../config.js";

// Reserve evenly spaced request slots in Redis, shared by all reader workers.
const script = `
local key = KEYS[1]
local interval = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local next_at = tonumber(redis.call('GET', key)) or now
local slot = math.max(now, next_at)
redis.call('SET', key, slot + interval, 'PX', interval * 4)
return slot - now
`;

export async function acquireBmwPermit(): Promise<void> {
  const { redis } = await import("../redis.js");
  // Stay below a boundary-based API quota too: exactly 3 evenly spaced calls
  // per second can still create a 4-call sliding one-second window.
  const safeRate = Math.max(1, config.BMW_RATE_LIMIT_PER_SEC - 1);
  const intervalMs = Math.ceil(1000 / safeRate);
  const waitMs = Number(await redis.eval(script, 1, "bmw-reader:rate:next", intervalMs));
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
