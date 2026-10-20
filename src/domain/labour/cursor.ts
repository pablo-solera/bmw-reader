import { ValidationError } from "reader-core/domain/errors";

export function parseLabourCursor(cursor?: string): number {
  if (!cursor) return 0;
  let decoded: string;
  try { decoded = Buffer.from(cursor, "base64url").toString("utf8"); }
  catch { throw new ValidationError("cursor is invalid"); }
  const parts = decoded.split(":");
  const offset = Number(parts.length === 2 ? parts[1] : decoded);
  if ((parts.length === 2 && parts[0] !== "v1") || !Number.isSafeInteger(offset) || offset < 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ValidationError("cursor is invalid");
  return offset;
}

export function labourNextCursor(start: number) { return Buffer.from(`v1:${start}`).toString("base64url"); }
