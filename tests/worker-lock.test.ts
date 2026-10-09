import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import express from "express";
import { createSystemRouter } from "reader-core/interfaces/http/express/system-router";
import { assertWorkerAlive, clearWorkerHeartbeat, workerHeartbeatKey, workerLockKey } from "../src/worker-lock.js";

const docs = "<!doctype html><html><body>docs</body></html>";

async function withServer(run: (baseUrl: string) => Promise<void>, checks: Record<string, () => Promise<void>>) {
  const app = express();
  app.use(createSystemRouter({}, docs, checks));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe("BMW worker readiness", () => {
  test("fails readiness when the heartbeat key is missing or expired", async () => {
    for (const ttl of [-2, -1, 0]) {
      await expect(assertWorkerAlive({ pttl: async () => ttl })).rejects.toThrow("Worker heartbeat is missing or expired");
    }
  });

  test("accepts an unexpired worker heartbeat", async () => {
    await expect(assertWorkerAlive({ pttl: async () => 15_000 })).resolves.toBeUndefined();
  });

  test("clears the heartbeat only when this worker still owns the singleton lock", async () => {
    const evalMock = async (script: string, keyCount: number, ...args: Array<string | number>) => {
      expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
      expect(script).toContain("redis.call('DEL', KEYS[2])");
      expect(keyCount).toBe(2);
      expect(args).toEqual([workerLockKey, workerHeartbeatKey, "worker-token"]);
      return 1;
    };

    await expect(clearWorkerHeartbeat({ eval: evalMock }, "worker-token")).resolves.toBe(true);
  });

  test("returns 503 and marks worker as error without a heartbeat", async () => {
  await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", checks: { worker: "error" } });
  }, { worker: async () => { await assertWorkerAlive({ pttl: async () => -2 }); } });
  });

  test("returns 200 when the worker heartbeat is present", async () => {
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready", checks: { worker: "ok" } });
  }, { worker: async () => { await assertWorkerAlive({ pttl: async () => 15_000 }); } });
  });
});
