export function normalizeModelSeries(value: string): string {
  const series = value.replace(/'/g, "").trim();
  if (!series || !/^[A-Za-z0-9 _.-]+$/.test(series) || series === "." || series === "..") {
    throw new Error("series contains invalid path characters");
  }
  return series;
}

export function resolveModelSeries(typekeySeries?: string, requestSeries?: string): string {
  return normalizeModelSeries(typekeySeries ?? requestSeries ?? "");
}

export function relativeTypekeyPath(group: string, manufacturer: string, series: string, family: string, date: string, typekey: string): string {
  return [group, manufacturer, "labour", normalizeModelSeries(series), family, date, typekey].join("/");
}
