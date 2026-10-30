import { ValidationError } from "@solera/core-reader/domain/errors";

export type LabourCursorPosition = { score: number; requestId: string };

export function parseLabourCursor(cursor?: string): LabourCursorPosition | null {
  if (!cursor) return null;
  let decoded: string;
  try { decoded = Buffer.from(cursor, "base64url").toString("utf8"); }
  catch { throw new ValidationError("cursor is invalid"); }
  const parts = decoded.split(":");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ValidationError("cursor is invalid");
  if (parts.length === 3 && parts[0] === "v2") {
    const score = Number(parts[1]);
    if (!Number.isSafeInteger(score) || score < 0 || !/^[A-Za-z0-9-]+$/.test(parts[2]!)) throw new ValidationError("cursor is invalid");
    return { score, requestId: parts[2]! };
  }
  throw new ValidationError("cursor is invalid");
}

export function labourNextCursor(position: LabourCursorPosition) {
  return Buffer.from(`v2:${position.score}:${position.requestId}`).toString("base64url");
}
