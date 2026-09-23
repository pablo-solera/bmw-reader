import { redis } from "../redis.js";
import { config } from "../config.js";

// One Redis sorted-set window shared by all API processes, rather than a per-job limiter.
const script = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window * 2)
  return 0
end
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return math.max(1, tonumber(first[2]) + window - now)
`;

export async function acquireBmwPermit(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const waitMs = Number(await redis.eval(script, 1, "bmw-reader:rate:window", now, 1000, config.BMW_RATE_LIMIT_PER_SEC, `${now}:${crypto.randomUUID()}`));
    if (waitMs <= 0) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 1000)));
  }
}
