import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { HttpRequest, HttpResponse } from "@smithy/core/protocols";
import { loadConfig } from "../src/config.js";
import { createBmwObjectStorage } from "../src/infrastructure/s3/object-storage.js";

describe("S3-compatible bulk delete", () => {
  test("adds Content-MD5 matching the exact DeleteObjects request body", async () => {
    const prefix = "BMW/BMW/labour/7/G70/20261021/21EC";
    const objectKey = `${prefix}/object.json`;
    let requestBody: string | Uint8Array | undefined;
    let contentMd5: string | undefined;
    const requestHandler = {
      async handle(request: HttpRequest) {
        if (Object.hasOwn(request.query, "delete")) {
          requestBody = request.body as string | Uint8Array;
          contentMd5 = request.headers["content-md5"];
          return {
            response: new HttpResponse({
              statusCode: 200,
              headers: { "content-type": "application/xml" },
              body: Readable.from([`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>${objectKey}</Key></Deleted></DeleteResult>`]),
            }),
          };
        }
        return {
          response: new HttpResponse({
            statusCode: 200,
            headers: { "content-type": "application/xml" },
            body: Readable.from([`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>${objectKey}</Key><LastModified>2026-10-21T00:00:00.000Z</LastModified><ETag>etag</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`]),
          }),
        };
      },
      destroy() {},
    } as unknown as S3ClientConfig["requestHandler"];
    const storage = createBmwObjectStorage(loadConfig({
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY: "test-access",
      S3_SECRET_ACCESS_KEY: "test-secret",
    }), requestHandler);

    expect(await storage.deletePrefix(prefix)).toBe(1);
    const bytes = typeof requestBody === "string" ? Buffer.from(requestBody) : Buffer.from(requestBody ?? []);
    expect(contentMd5).toBe(createHash("md5").update(bytes).digest("base64"));
  });
});
