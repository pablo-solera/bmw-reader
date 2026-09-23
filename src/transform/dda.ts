export type DdaRule = "exact" | "inclusive" | "absent";
export function normalizeOperation(value: string) { return value.replace(/[\s)]/g, "").replace(/ZAX/gi, ""); }
export function ddaRule(operation: string): DdaRule { return /ZAX/i.test(operation) ? "absent" : operation.includes(")") ? "inclusive" : "exact"; }
export function ddaMismatch(operation: string, ddaValue: unknown, bmwValue: unknown) {
  const rule = ddaRule(operation);
  if (rule === "absent") return bmwValue !== "" && bmwValue != null;
  const dda = Number(ddaValue), bmw = Number(bmwValue);
  if (!Number.isFinite(dda) || !Number.isFinite(bmw)) return rule === "exact" ? String(ddaValue ?? "") !== String(bmwValue ?? "") : false;
  return rule === "exact" ? dda !== bmw : dda >= bmw;
}
