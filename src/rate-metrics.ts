import { config } from "./config.js";
import { redis } from "./redis.js";

export type MinuteMetric = { minute: number; requests: number; permits: number; rateLimited: number; completedOids: number; bmwLatencyMs: number; bmwLatencyCount: number; s3PutMs: number; s3Puts: number };

export function summarizeMetrics(metrics: MinuteMetric[], now = Date.now(), windowMinutes = 5) {
  const firstMinute = Math.floor(now / 60000) - windowMinutes + 1;
  const rows = metrics.filter(row => row.minute >= firstMinute && row.minute <= Math.floor(now / 60000));
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const permits = rows.reduce((sum, row) => sum + row.permits, 0);
  const rateLimited = rows.reduce((sum, row) => sum + row.rateLimited, 0);
  const completedOids = rows.reduce((sum, row) => sum + row.completedOids, 0);
  const bmwLatencyMs = rows.reduce((sum, row) => sum + row.bmwLatencyMs, 0);
  const bmwLatencyCount = rows.reduce((sum, row) => sum + row.bmwLatencyCount, 0);
  const s3PutMs = rows.reduce((sum, row) => sum + row.s3PutMs, 0);
  const s3Puts = rows.reduce((sum, row) => sum + row.s3Puts, 0);
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
    avgBmwLatencyMs: bmwLatencyCount ? Number((bmwLatencyMs / bmwLatencyCount).toFixed(1)) : 0,
    avgS3PutMs: s3Puts ? Number((s3PutMs / s3Puts).toFixed(1)) : 0,
    s3Puts,
  };
}

export type MetricKind = "requests" | "permits" | "429" | "oids" | "bmw-latency-ms" | "bmw-latency-count" | "s3-put-ms" | "s3-puts";
export const metricKey = (minute: number, kind: MetricKind, requestId?: string) =>
  `bmw-reader:metrics:${minute}:${requestId ? `job:${requestId}:` : ""}${kind}`;

function incrementMetrics(metrics: Array<{ kind: MetricKind; amount?: number }>, requestId?: string) {
  const minute = Math.floor(Date.now() / 60000);
  const pipeline = redis.pipeline();
  for (const { kind, amount = 1 } of metrics) {
    const keys = [metricKey(minute, kind), ...(requestId ? [metricKey(minute, kind, requestId)] : [])];
    for (const key of keys) {
      pipeline.incrby(key, amount);
      pipeline.pexpire(key, 10 * 60 * 1000);
    }
  }
  void pipeline.exec().then(results => {
    const failure = results?.find(([error]) => error)?.[0];
    if (failure) throw failure;
  }).catch(error => console.warn(JSON.stringify({ event: "bmw_metric_write_failed", error: error instanceof Error ? error.message : String(error) })));
}

function incrementMetric(kind: MetricKind, requestId?: string, amount = 1) { incrementMetrics([{ kind, amount }], requestId); }
export function recordBmwRequest(requestId?: string) { incrementMetric("requests", requestId); }
export function recordBmwPermit(requestId?: string) { incrementMetric("permits", requestId); }
export function recordRateLimitedRequest(requestId?: string, requestCount = 1) { incrementMetric("429", requestId, requestCount); }
export function recordCompletedOid(requestId?: string, amount = 1) { incrementMetric("oids", requestId, amount); }
export function recordBmwLatency(requestId: string | undefined, elapsedMs: number) {
  incrementMetrics([{ kind: "bmw-latency-ms", amount: Math.max(0, Math.round(elapsedMs)) }, { kind: "bmw-latency-count" }], requestId);
}
export function recordS3PutLatency(requestId: string | undefined, elapsedMs: number) {
  incrementMetrics([{ kind: "s3-put-ms", amount: Math.max(0, Math.round(elapsedMs)) }, { kind: "s3-puts" }], requestId);
}

export async function getBmwMetrics(requestId?: string, windowMinutes = 5) {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const minutes = Array.from({ length: windowMinutes }, (_, index) => currentMinute - windowMinutes + 1 + index);
  const values = await redis.mget(...minutes.flatMap(minute => [
    metricKey(minute, "requests", requestId), metricKey(minute, "permits", requestId), metricKey(minute, "429", requestId), metricKey(minute, "oids", requestId),
    metricKey(minute, "bmw-latency-ms", requestId), metricKey(minute, "bmw-latency-count", requestId), metricKey(minute, "s3-put-ms", requestId), metricKey(minute, "s3-puts", requestId),
  ]));
  const metricsPerMinute = 8;
  const rows: MinuteMetric[] = minutes.map((minute, index) => ({
    minute,
    requests: Number(values[index * metricsPerMinute] ?? 0),
    permits: Number(values[index * metricsPerMinute + 1] ?? 0),
    rateLimited: Number(values[index * metricsPerMinute + 2] ?? 0),
    completedOids: Number(values[index * metricsPerMinute + 3] ?? 0),
    bmwLatencyMs: Number(values[index * metricsPerMinute + 4] ?? 0),
    bmwLatencyCount: Number(values[index * metricsPerMinute + 5] ?? 0),
    s3PutMs: Number(values[index * metricsPerMinute + 6] ?? 0),
    s3Puts: Number(values[index * metricsPerMinute + 7] ?? 0),
  }));
  return summarizeMetrics(rows, now, windowMinutes);
}

export async function logBmwMetricsMinute() {
  const minute = Math.floor(Date.now() / 60000);
  const logKey = "bmw-reader:metrics:last-log-minute";
  if (await redis.set(logKey, String(minute), "EX", 180, "NX") !== "OK") return;
  console.info(JSON.stringify({ event: "bmw_throughput_minute", metrics: await getBmwMetrics(undefined, 1), configuredRequestsPerSecond: config.BMW_RATE_LIMIT_PER_SEC }));
}
