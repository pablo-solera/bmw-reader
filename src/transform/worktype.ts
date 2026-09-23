export function extractSpecialEquipment(expression: string) {
  const match = expression.match(/SONDERAUSSTATTUNG\s*\(?\s*['"]?([A-Z0-9]{4})/i);
  return match?.[1] ?? "";
}
export function workTypeLabel(value: string) {
  const [kind, suffix] = value.trim().split(/\s+/, 2);
  const labels: Record<string, string> = { HAUPTARBEIT: "T.P.", VERBUNDARBEIT: "T.A.", PLUSARBEIT: "P.P", SONSTIGE_VERBUNDARBEIT: "O.T.A." };
  const label = labels[kind ?? ""] ?? (kind ? "===" : "");
  return suffix ? `${label} ${suffix}` : label;
}
