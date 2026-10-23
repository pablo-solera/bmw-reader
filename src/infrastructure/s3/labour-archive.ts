import archiver from "archiver";
import type { BmwObjectStorage } from "./object-storage.js";

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
    void (async () => {
      for (const key of entries) await addEntry(key, await storage.getObjectStream(key));
      await archive.finalize();
    })().catch(error => archive.destroy(error instanceof Error ? error : new Error(String(error))));
  };
  return { stream: archive, start };
}
