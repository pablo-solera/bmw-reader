import { Redis } from "ioredis";
import { workerHeartbeatKey } from "./infrastructure/redis/worker-lock.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 3000 });
redis.on("error", () => undefined);
try {
  await redis.connect();
  const ttl = await redis.pttl(workerHeartbeatKey);
  process.exitCode = ttl > 0 ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
