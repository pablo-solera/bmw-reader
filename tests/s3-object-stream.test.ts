import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { HttpResponse } from "@smithy/core/protocols";
import { loadConfig } from "../src/config.js";
import { createBmwObjectStorage } from "../src/infrastructure/s3/object-storage.js";

function storageWithBody(body: unknown) {
  const requestHandler = {
    async handle() { return { response: new HttpResponse({ statusCode: 200, headers: { "content-type": "application/json" }, body }) }; },
    destroy() {},
  } as unknown as S3ClientConfig["requestHandler"];
  return createBmwObjectStorage(loadConfig({
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
  }), requestHandler);
}

async function read(stream: NodeJS.ReadableStream) {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk as Buffer).toString();
  return text;
}

describe("getObjectStream", () => {
  test("reads Node stream bodies", async () => {
    expect(await read(await storageWithBody(Readable.from(["hello"])).getObjectStream("a/b.json"))).toBe("hello");
  });

  test("converts web stream bodies, which Bun returns, into Node streams", async () => {
    const web = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("web")); controller.close(); } });
    expect(await read(await storageWithBody(web).getObjectStream("a/b.json"))).toBe("web");
  });
});
