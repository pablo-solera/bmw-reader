import { RedisLeaseLock, type RedisLockClient } from "reader-core/infrastructure/redis/lock";
export type WorkerLockRedis = RedisLockClient;

export const workerLockKey = "bmw-reader:worker:singleton";
export const workerHeartbeatKey = "bmw-reader:worker:heartbeat";

const renewScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], 30000); redis.call('SET', KEYS[2], ARGV[2], 'PX', 30000); return 1 else return 0 end";
const clearHeartbeatScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[2]) else return 0 end";

export async function acquireWorkerLock(client: WorkerLockRedis, token: string): Promise<boolean> {
  const lock = new RedisLeaseLock(client);
  return lock.acquire(workerLockKey, token, 30000);
}

export async function renewWorkerLock(client: WorkerLockRedis, token: string, now = Date.now()): Promise<boolean> {
  return Number(await client.eval(renewScript, 2, workerLockKey, workerHeartbeatKey, token, now)) === 1;
}

export async function assertWorkerAlive(client: { pttl(key: string): Promise<number> }): Promise<void> {
  if (await client.pttl(workerHeartbeatKey) <= 0) throw new Error("Worker heartbeat is missing or expired");
}

export async function clearWorkerHeartbeat(client: Pick<WorkerLockRedis, "eval">, token: string): Promise<boolean> {
  return Number(await client.eval(clearHeartbeatScript, 2, workerLockKey, workerHeartbeatKey, token)) === 1;
}

export async function releaseWorkerLock(client: WorkerLockRedis, token: string): Promise<void> {
  const lock = new RedisLeaseLock(client);
  await lock.release(workerLockKey, token);
}
