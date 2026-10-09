import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, type ServiceInputTypes } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Store } from "reader-core/storage/s3";
import { config } from "./config.js";

const requestTimeoutMs = 30_000;
const client = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.S3_ACCESS_KEY && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
  maxAttempts: 5,
  retryMode: "adaptive",
  requestHandler: new FetchHttpHandler({ requestTimeout: requestTimeoutMs }),
});
const store = new S3Store({ adapter: {
  async headBucket() { await sendS3(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), "head-bucket"); },
  async createBucket() { await sendS3(new CreateBucketCommand({ Bucket: config.S3_BUCKET }), "create-bucket"); },
  async putObject(key, body, contentType) { await sendS3(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }), "put-json"); },
  async getObject(key) {
    return withS3Timeout("get-json", async signal => {
      const result = await client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { abortSignal: signal });
      return result.Body ? result.Body.transformToString("utf-8") : undefined;
    });
  },
  signGet(key, expiresInSeconds) { return getSignedUrl(client, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn: expiresInSeconds }); },
  async list(prefix, continuationToken) {
    const page = await sendS3<Awaited<ReturnType<S3Client["send"]>> & { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }), "list-delete-prefix");
    return { keys: (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []), nextToken: page.NextContinuationToken };
  },
  async deleteObject(key) { await sendS3(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), "delete-object"); },
}, autoCreateBucket: config.s3AutoCreateBucket, expiresInSeconds: 900 });

async function withS3Timeout<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`S3 ${operation} timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
  const startedAt = Date.now();
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 5000) console.info(JSON.stringify({ event: "s3_operation_slow", operation, elapsedMs }));
  }
}
async function sendS3<O>(command: { readonly input: ServiceInputTypes }, operation: string): Promise<O> {
  return withS3Timeout(operation, signal => client.send(command as never, { abortSignal: signal }) as Promise<O>);
}

export function objectKey(...parts: string[]) {
  return [config.S3_PREFIX, ...parts].map(x => x.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
export function isTypekeyPrefix(prefix: string) {
  const normalized = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const configuredPrefix = config.S3_PREFIX.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || (configuredPrefix && !normalized.startsWith(`${configuredPrefix}/`))) return false;
  const parts = normalized.slice(configuredPrefix ? configuredPrefix.length + 1 : 0).split("/");
  return parts.length === 7 && parts[2] === "labour" && /^\d{8}$/.test(parts[5]!) && /^[A-Z0-9]{4}$/.test(parts[6]!);
}
export async function ensureBucket() {
  try { await store.ensureBucket(); }
  catch { throw new Error(`Cannot access S3 bucket ${config.S3_BUCKET}; S3_AUTO_CREATE_BUCKET only permits creation after a 404`); }
}
export async function checkBucket() {
  await store.headBucket();
}
export async function signedDownload(key: string) {
  return store.signedDownload(key);
}
export async function putJson(key: string, value: unknown) {
  await store.putJson(key, value, true);
}
export async function putJsonCompact(key: string, value: unknown) {
  await store.putJson(key, value, false);
}
export async function deletePrefix(prefix: string) {
  return store.deletePrefix(prefix, isTypekeyPrefix);
}
export async function getJson<T>(key: string): Promise<T> {
  return store.getJson<T>(key);
}
export async function getJsonIfExists<T>(key: string): Promise<T | undefined> {
  try { return await getJson<T>(key); }
  catch (error) {
    const value = error as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } };
    if (value.name === "NoSuchKey" || value.name === "NotFound" || value.statusCode === 404 || value.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}
