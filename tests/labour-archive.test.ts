import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createLabourArchiveStream } from "../src/infrastructure/s3/labour-archive.js";

async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("createLabourArchiveStream", () => {
  test("finalizes a ZIP containing every object", async () => {
    const objects: Record<string, string> = { "p/a/one.json": "1", "p/a/two.json": "22", "p/a/three.json": "333" };
    const archive = await createLabourArchiveStream({
      listObjects: async () => Object.keys(objects),
      getObjectStream: async key => Readable.from([Buffer.from(objects[key]!)]),
    }, ["p/a"], "p");
    expect(archive).not.toBeNull();
    const done = collect(archive!.stream);
    archive!.start();
    const zip = await done;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const text = zip.toString("latin1");
    for (const name of ["a/one.json", "a/two.json", "a/three.json"]) expect(text).toContain(name);
  });

  test("aborts the stream when an object cannot be read", async () => {
    const archive = await createLabourArchiveStream({
      listObjects: async () => ["p/a/one.json"],
      getObjectStream: async () => { throw new Error("boom"); },
    }, ["p/a"], "p");
    const done = collect(archive!.stream);
    archive!.start();
    await expect(done).rejects.toThrow("boom");
  });

  test("returns null when there is nothing to archive", async () => {
    expect(await createLabourArchiveStream({ listObjects: async () => [], getObjectStream: async () => Readable.from([]) }, ["p/a"], "p")).toBeNull();
  });
});
