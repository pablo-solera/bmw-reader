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
  let index = 0;
  const appendNext = () => {
    const key = entries[index++];
    if (!key) {
      void archive.finalize().catch(error => archive.destroy(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    void storage.getObjectStream(key).then(source => {
      const name = objectPrefix && key.startsWith(`${objectPrefix}/`) ? key.slice(objectPrefix.length + 1) : key;
      archive.append(source, { name }, error => error ? archive.destroy(error) : appendNext());
    }).catch(error => archive.destroy(error instanceof Error ? error : new Error(String(error))));
  };
  return { stream: archive, start: appendNext };
}
