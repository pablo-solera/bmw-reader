import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { config } from "./config.js";

const client = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.S3_ACCESS_KEY && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
  maxAttempts: 5,
  retryMode: "adaptive",
  requestHandler: new NodeHttpHandler({ connectionTimeout: 10000, requestTimeout: 120000 }),
});

export function objectKey(...parts: string[]) {
  return [config.S3_PREFIX, ...parts].map(x => x.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
export async function ensureBucket() {
  try { await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (!config.s3AutoCreateBucket || status !== 404) throw new Error(`Cannot access S3 bucket ${config.S3_BUCKET}; S3_AUTO_CREATE_BUCKET only permits creation after a 404`);
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
}
export async function putJson(key: string, value: unknown) {
  await client.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: JSON.stringify(value, null, 2), ContentType: "application/json; charset=utf-8" }));
}
export async function putBytes(key: string, body: Uint8Array, contentType: string) {
  await client.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}
export async function deletePrefix(prefix: string) {
  if (!prefix || !prefix.startsWith(`${config.S3_PREFIX}/`)) throw new Error("Refusing to delete objects outside S3_PREFIX");
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    const keys = (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []);
    for (let index = 0; index < keys.length; index += 10) {
      await Promise.all(keys.slice(index, index + 10).map(Key => client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key }))));
      deleted += Math.min(10, keys.length - index);
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return deleted;
}
export async function getJson<T>(key: string): Promise<T> {
  const result = await client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
  return JSON.parse(await result.Body.transformToString("utf-8")) as T;
}
export async function signedDownload(key: string, expiresIn = 900) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn });
}
