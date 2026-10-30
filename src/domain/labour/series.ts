import { ValidationError } from "@pablosla/core-reader/domain/errors";

export function normalizeModelSeries(value: string): string {
  const series = value.replace(/'/g, "").trim();
  if (!series || !/^[A-Za-z0-9 _.-]+$/.test(series) || series === "." || series === "..") {
    throw new ValidationError("series contains invalid path characters");
  }
  return series;
}

export function resolveModelSeries(typekeySeries?: string, requestSeries?: string): string {
  return normalizeModelSeries(typekeySeries ?? requestSeries ?? "");
}
