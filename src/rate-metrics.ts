import { config } from "./config.js";

export type MinuteMetric = { minute: number; requests: number; permits: number; rateLimited: number; completedOids: number };

export function summarizeMetrics(metrics: MinuteMetric[], now = Date.now(), windowMinutes = 5) {
  const firstMinute = Math.floor(now / 60000) - windowMinutes + 1;
  const rows = metrics.filter(row => row.minute >= firstMinute && row.minute <= Math.floor(now / 60000));
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const permits = rows.reduce((sum, row) => sum + row.permits, 0);
  const rateLimited = rows.reduce((sum, row) => sum + row.rateLimited, 0);
  const completedOids = rows.reduce((sum, row) => sum + row.completedOids, 0);
  const elapsedSeconds = rows.length
    ? Math.max(1, Math.min(windowMinutes * 60, (Math.floor(now / 60000) - Math.min(...rows.map(row => row.minute)) + 1) * 60))
    : windowMinutes * 60;
  const elapsedMinutes = elapsedSeconds / 60;
  return {
    windowMinutes,
    requests,
    permits,
    permitsPerSecond: Number((permits / elapsedSeconds).toFixed(3)),
    requestsPerSecond: Number((requests / elapsedSeconds).toFixed(3)),
    rateLimited,
    rateLimitedPercentage: permits === 0 ? 0 : Number((rateLimited / permits * 100).toFixed(2)),
    completedOids,
    completedOidsPerMinute: Number((completedOids / elapsedMinutes).toFixed(2)),
  };
}

export const metricKey = (minute: number, kind: "requests" | "permits" | "429" | "oids", requestId?: string) =>
  `bmw-reader:metrics:${minute}:${requestId ? `job:${requestId}:` : ""}${kind}`;

async function incrementMetric(kind: "requests" | "permits" | "429" | "oids", requestId?: string, amount = 1) {
  const { redis } = await import("./redis.js");
  const minute = Math.floor(Date.now() / 60000);
  const keys = [metricKey(minute, kind), ...(requestId ? [metricKey(minute, kind, requestId)] : [])];
  for (const key of keys) {
    await redis.incrby(key, amount);
    await redis.pexpire(key, 10 * 60 * 1000);
  }
}

export async function recordBmwRequest(requestId?: string) { await incrementMetric("requests", requestId); }
export async function recordBmwPermit(requestId?: string) { await incrementMetric("permits", requestId); }
export async function recordRateLimitedRequest(requestId?: string, requestCount = 1) { await incrementMetric("429", requestId, requestCount); }
export async function recordCompletedOid(requestId?: string, amount = 1) { await incrementMetric("oids", requestId, amount); }

export async function getBmwMetrics(requestId?: string, windowMinutes = 5) {
  const { redis } = await import("./redis.js");
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const minutes = Array.from({ length: windowMinutes }, (_, index) => currentMinute - windowMinutes + 1 + index);
  const rows: MinuteMetric[] = [];
  for (const minute of minutes) {
    const [requests, permits, rateLimited, completedOids] = await redis.mget(
      metricKey(minute, "requests", requestId), metricKey(minute, "permits", requestId), metricKey(minute, "429", requestId), metricKey(minute, "oids", requestId),
    );
    rows.push({ minute, requests: Number(requests ?? 0), permits: Number(permits ?? 0), rateLimited: Number(rateLimited ?? 0), completedOids: Number(completedOids ?? 0) });
  }
  return summarizeMetrics(rows, now, windowMinutes);
}

export async function logBmwMetricsMinute() {
  const { redis } = await import("./redis.js");
  const minute = Math.floor(Date.now() / 60000);
  const logKey = "bmw-reader:metrics:last-log-minute";
  if (await redis.set(logKey, String(minute), "EX", 180, "NX") !== "OK") return;
  console.info(JSON.stringify({ event: "bmw_throughput_minute", metrics: await getBmwMetrics(undefined, 1), configuredRequestsPerSecond: config.BMW_RATE_LIMIT_PER_SEC }));
}
