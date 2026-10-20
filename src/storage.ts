import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type ServiceInputTypes,
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Store } from "reader-core/infrastructure/s3/object-storage";
import type { AppConfig } from "./config.js";

const requestTimeoutMs = 30_000;
export type BmwObjectStorage = ReturnType<typeof createBmwObjectStorage>;

export function createBmwObjectStorage(settings: AppConfig) {
  const client = new S3Client({
    region: settings.S3_REGION,
    endpoint: settings.S3_ENDPOINT,
    forcePathStyle: settings.s3ForcePathStyle,
    credentials: settings.S3_ACCESS_KEY && settings.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: settings.S3_ACCESS_KEY, secretAccessKey: settings.S3_SECRET_ACCESS_KEY }
      : undefined,
    maxAttempts: 5,
    retryMode: "adaptive",
    requestHandler: new FetchHttpHandler({ requestTimeout: requestTimeoutMs }),
  });

  async function withS3Timeout<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`S3 ${operation} timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    const startedAt = Date.now();
    try { return await run(controller.signal); }
    finally {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 5000) console.info(JSON.stringify({ event: "s3_operation_slow", operation, elapsedMs }));
    }
  }

  async function sendS3<O>(command: { readonly input: ServiceInputTypes }, operation: string): Promise<O> {
    return withS3Timeout(operation, signal => client.send(command as never, { abortSignal: signal }) as Promise<O>);
  }

  const store = new S3Store({
    adapter: {
      async headBucket() { await sendS3(new HeadBucketCommand({ Bucket: settings.S3_BUCKET }), "head-bucket"); },
      async createBucket() { await sendS3(new CreateBucketCommand({ Bucket: settings.S3_BUCKET }), "create-bucket"); },
      async putObject(key, body, contentType) { await sendS3(new PutObjectCommand({ Bucket: settings.S3_BUCKET, Key: key, Body: body, ContentType: contentType }), "put-json"); },
      async getObject(key) {
        return withS3Timeout("get-json", async signal => {
          const result = await client.send(new GetObjectCommand({ Bucket: settings.S3_BUCKET, Key: key }), { abortSignal: signal });
          return result.Body ? result.Body.transformToString("utf-8") : undefined;
        });
      },
      signGet(key, expiresInSeconds) { return getSignedUrl(client, new GetObjectCommand({ Bucket: settings.S3_BUCKET, Key: key }), { expiresIn: expiresInSeconds }); },
      async list(prefix, continuationToken) {
        const page = await sendS3<Awaited<ReturnType<S3Client["send"]>> & { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: settings.S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }), "list-delete-prefix");
        return { keys: (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []), nextToken: page.NextContinuationToken };
      },
      async deleteObject(key) { await sendS3(new DeleteObjectCommand({ Bucket: settings.S3_BUCKET, Key: key }), "delete-object"); },
      async deleteObjects(keys) {
        if (!keys.length) return;
        const result = await sendS3<{ Errors?: Array<{ Key?: string; Code?: string; Message?: string }> }>(
          new DeleteObjectsCommand({ Bucket: settings.S3_BUCKET, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }),
          "delete-objects",
        );
        if (result.Errors?.length) throw new Error(`S3 failed to delete ${result.Errors.length} object(s): ${result.Errors.slice(0, 5).map(item => `${item.Key ?? "unknown"} (${item.Code ?? item.Message ?? "unknown error"})`).join(", ")}`);
      },
    },
    autoCreateBucket: settings.s3AutoCreateBucket,
    expiresInSeconds: 900,
  });

  function objectKey(...parts: string[]) {
    return [settings.S3_PREFIX, ...parts].map(part => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  }

  function isTypekeyPrefix(prefix: string) {
    const normalized = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const configuredPrefix = settings.S3_PREFIX.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized || (configuredPrefix && !normalized.startsWith(`${configuredPrefix}/`))) return false;
    const parts = normalized.slice(configuredPrefix ? configuredPrefix.length + 1 : 0).split("/");
    return parts.length === 7 && parts[2] === "labour" && /^\d{8}$/.test(parts[5]!) && /^[A-Z0-9]{4}$/.test(parts[6]!);
  }

  return {
    objectKey,
    isTypekeyPrefix,
    async ensureBucket() {
      try { await store.ensureBucket(); }
      catch { throw new Error(`Cannot access S3 bucket ${settings.S3_BUCKET}; S3_AUTO_CREATE_BUCKET only permits creation after a 404`); }
    },
    checkBucket: () => store.headBucket(),
    signedDownload: (key: string) => store.signedDownload(key),
    putJson: (key: string, value: unknown) => store.putJson(key, value, true),
    putJsonCompact: (key: string, value: unknown) => store.putJson(key, value, false),
    deletePrefix: (prefix: string) => store.deletePrefix(prefix, isTypekeyPrefix),
    getJson: <T>(key: string) => store.getJson<T>(key),
    async getJsonIfExists<T>(key: string): Promise<T | undefined> {
      try { return await store.getJson<T>(key); }
      catch (error) {
        const value = error as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } };
        if (value.name === "NoSuchKey" || value.name === "NotFound" || value.statusCode === 404 || value.$metadata?.httpStatusCode === 404) return undefined;
        throw error;
      }
    },
  };
}
