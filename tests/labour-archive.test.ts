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

  test("opens objects ahead of time but keeps the entries in sorted order and bounded", async () => {
    const keys = Array.from({ length: 30 }, (_value, index) => `p/a/${String(index).padStart(2, "0")}.json`);
    let open = 0;
    let started = 0;
    let finished = 0;
    let peakOpenAhead = 0;
    const archive = await createLabourArchiveStream({
      listObjects: async () => [...keys].reverse(),
      getObjectStream: async key => {
        started++;
        peakOpenAhead = Math.max(peakOpenAhead, started - finished);
        open++;
        await new Promise(resolve => setTimeout(resolve, 2));
        const stream = Readable.from([Buffer.from(key)]);
        stream.on("end", () => { finished++; open--; });
        return stream;
      },
    }, ["p/a"], "p");
    const done = collect(archive!.stream);
    archive!.start();
    const text = (await done).toString("latin1");
    const positions = keys.map(key => text.indexOf(key.slice(2)));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(peakOpenAhead).toBeGreaterThan(1);
    expect(peakOpenAhead).toBeLessThanOrEqual(9);
    expect(open).toBe(0);
  });

  test("destroys the objects opened ahead when one fails", async () => {
    const destroyed: string[] = [];
    const archive = await createLabourArchiveStream({
      listObjects: async () => ["p/a/1.json", "p/a/2.json", "p/a/3.json"],
      getObjectStream: async key => {
        if (key.endsWith("1.json")) throw new Error("boom");
        const stream = new Readable({ read() {} });
        stream.on("close", () => destroyed.push(key));
        return stream;
      },
    }, ["p/a"], "p");
    const done = collect(archive!.stream);
    archive!.start();
    await expect(done).rejects.toThrow("boom");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(destroyed.sort()).toEqual(["p/a/2.json", "p/a/3.json"]);
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
