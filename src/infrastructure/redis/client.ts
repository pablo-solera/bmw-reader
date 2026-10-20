import { Redis } from "ioredis";

export function createRedisClient(url: string, options: { maxRetriesPerRequest?: number | null } = {}) {
  return new Redis(url, { ...options, maxRetriesPerRequest: options.maxRetriesPerRequest ?? null, protocol: 2 });
}
