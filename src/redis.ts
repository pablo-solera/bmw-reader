import { Redis } from "ioredis";
import { config } from "./config.js";

export function createRedisClient(url = config.REDIS_URL, options: { maxRetriesPerRequest?: number | null } = {}) {
  return new Redis(url, { ...options, maxRetriesPerRequest: options.maxRetriesPerRequest ?? null, protocol: 2 });
}

export const redis = createRedisClient();
