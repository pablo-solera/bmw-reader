import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, type ServiceInputTypes } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { config } from "./config.js";

type S3PutObserver = (elapsedMs: number) => void;
let s3PutObserver: S3PutObserver | undefined;
export function setS3PutObserver(observer?: S3PutObserver) { s3PutObserver = observer; }

const client = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.S3_ACCESS_KEY && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
  maxAttempts: 5,
  retryMode: "adaptive",
  requestHandler: new FetchHttpHandler({ requestTimeout: config.S3_REQUEST_TIMEOUT_MS }),
});

async function withS3Timeout<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`S3 ${operation} timed out after ${config.S3_REQUEST_TIMEOUT_MS}ms`)), config.S3_REQUEST_TIMEOUT_MS);
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
export async function ensureBucket() {
  try { await sendS3(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), "head-bucket"); }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (!config.s3AutoCreateBucket || status !== 404) throw new Error(`Cannot access S3 bucket ${config.S3_BUCKET}; S3_AUTO_CREATE_BUCKET only permits creation after a 404`);
    await sendS3(new CreateBucketCommand({ Bucket: config.S3_BUCKET }), "create-bucket");
  }
}
export async function putJson(key: string, value: unknown) {
  const startedAt = Date.now();
  try { await sendS3(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: JSON.stringify(value, null, 2), ContentType: "application/json; charset=utf-8" }), "put-json"); }
  finally { s3PutObserver?.(Date.now() - startedAt); }
}
export async function putJsonCompact(key: string, value: unknown) {
  const startedAt = Date.now();
  try { await sendS3(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: JSON.stringify(value), ContentType: "application/json; charset=utf-8" }), "put-json"); }
  finally { s3PutObserver?.(Date.now() - startedAt); }
}
export async function putBytes(key: string, body: Uint8Array, contentType: string) {
  const startedAt = Date.now();
  try { await sendS3(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }), "put-bytes"); }
  finally { s3PutObserver?.(Date.now() - startedAt); }
}
export async function deletePrefix(prefix: string) {
  if (!prefix || !prefix.startsWith(`${config.S3_PREFIX}/`)) throw new Error("Refusing to delete objects outside S3_PREFIX");
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const page = await sendS3<Awaited<ReturnType<S3Client["send"]>> & { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }), "list-delete-prefix");
    const keys = (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []);
    for (let index = 0; index < keys.length; index += 10) {
      await Promise.all(keys.slice(index, index + 10).map(Key => sendS3(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key }), "delete-object")));
      deleted += Math.min(10, keys.length - index);
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return deleted;
}
export async function listObjectKeys(prefix: string, maxKeysPerPage = 1000, maxObjects?: number, onPage?: (keys: string[]) => void) {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await sendS3<{ Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: maxKeysPerPage }), "list-objects");
    const pageKeys = (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []);
    keys.push(...pageKeys);
    onPage?.(pageKeys);
    if (maxObjects !== undefined && keys.length >= maxObjects) return keys.slice(0, maxObjects);
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return keys;
}
export async function getJson<T>(key: string): Promise<T> {
  return withS3Timeout("get-json", async signal => {
    const result = await client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { abortSignal: signal });
    if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
    return JSON.parse(await result.Body.transformToString("utf-8")) as T;
  });
}
export async function getJsonIfExists<T>(key: string): Promise<T | undefined> {
  try { return await getJson<T>(key); }
  catch (error) {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}
export async function signedDownload(key: string, expiresIn = 900) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn });
}
