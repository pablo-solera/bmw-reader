import archiver from "archiver";
import type { BmwObjectStorage } from "./object-storage.js";

const PREFETCH = 8;

export async function createLabourArchiveStream(
  storage: Pick<BmwObjectStorage, "listObjects" | "getObjectStream">,
  prefixes: string[],
  objectPrefix: string,
) {
  const keys = new Set<string>();
  for (const prefix of prefixes) {
    for (const key of await storage.listObjects(prefix)) keys.add(key);
  }
  const entries = [...keys].sort().filter(key => {
    const relative = objectPrefix && key.startsWith(`${objectPrefix}/`) ? key.slice(objectPrefix.length + 1) : key;
    return !relative.startsWith("/") && !relative.split(/[\\/]/).includes("..");
  });
  if (!entries.length) return null;
  const archive = archiver("zip", { zlib: { level: 6 } });
  const toName = (key: string) => objectPrefix && key.startsWith(`${objectPrefix}/`) ? key.slice(objectPrefix.length + 1) : key;
  const addEntry = (key: string, source: NodeJS.ReadableStream) => new Promise<void>((resolve, reject) => {
    const onEntry = () => { archive.off("error", onError); resolve(); };
    const onError = (error: Error) => { archive.off("entry", onEntry); reject(error); };
    archive.once("entry", onEntry);
    archive.once("error", onError);
    archive.append(source, { name: toName(key) });
  });
  const start = () => {
    // The objects are small and many, so the next ones are requested while the current one is being compressed;
    // they are still appended in sorted order, so the ZIP is identical to reading them one by one.
    const ahead: Promise<NodeJS.ReadableStream>[] = [];
    let nextToOpen = 0;
    const openAhead = () => {
      while (ahead.length < PREFETCH && nextToOpen < entries.length) {
        const opening = storage.getObjectStream(entries[nextToOpen++]!);
        opening.catch(() => undefined);
        ahead.push(opening);
      }
    };
    void (async () => {
      for (const key of entries) {
        openAhead();
        await addEntry(key, await ahead.shift()!);
      }
      await archive.finalize();
    })().catch(async error => {
      for (const opening of ahead) void opening.then(stream => (stream as { destroy?: () => void }).destroy?.(), () => undefined);
      archive.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
  return { stream: archive, start };
}
