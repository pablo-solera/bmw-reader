import { ValidationError } from "reader-core/domain/errors";

export type LabourCursorPosition = { kind: "offset"; offset: number } | { kind: "after"; score: number; requestId: string };

export function parseLabourCursor(cursor?: string): LabourCursorPosition {
  if (!cursor) return { kind: "offset", offset: 0 };
  let decoded: string;
  try { decoded = Buffer.from(cursor, "base64url").toString("utf8"); }
  catch { throw new ValidationError("cursor is invalid"); }
  const parts = decoded.split(":");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ValidationError("cursor is invalid");
  if (parts.length === 2 && parts[0] === "v1") {
    const offset = Number(parts[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError("cursor is invalid");
    return { kind: "offset", offset };
  }
  if (parts.length === 3 && parts[0] === "v2") {
    const score = Number(parts[1]);
    if (!Number.isSafeInteger(score) || score < 0 || !/^[A-Za-z0-9-]+$/.test(parts[2]!)) throw new ValidationError("cursor is invalid");
    return { kind: "after", score, requestId: parts[2]! };
  }
  throw new ValidationError("cursor is invalid");
}

export function labourNextCursor(start: number): string;
export function labourNextCursor(position: { score: number; requestId: string }): string;
export function labourNextCursor(position: number | { score: number; requestId: string }) {
  return Buffer.from(typeof position === "number" ? `v1:${position}` : `v2:${position.score}:${position.requestId}`).toString("base64url");
}
