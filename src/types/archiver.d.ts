declare module "archiver" {
  import { Transform } from "node:stream";

  interface Archive extends Transform {
    append(input: NodeJS.ReadableStream, data: { name: string }): this;
    finalize(): Promise<void>;
  }

  export default function archiver(format: "zip", options?: { zlib?: { level?: number } }): Archive;
}
