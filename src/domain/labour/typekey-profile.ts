export const COMPARED_ATTRIBUTES = ["model", "engine", "body", "transmission", "eDrive", "electricMotor", "doors", "market", "steering", "capacity", "power"] as const;
export type ComparedAttribute = (typeof COMPARED_ATTRIBUTES)[number];

export type TypekeyProfile = {
  typekey: string;
  baseType?: string;
  attributes: Partial<Record<ComparedAttribute, string>>;
  validFrom?: string;
  validUntil?: string;
};

export type TypekeyDifference = { attribute: ComparedAttribute | "validity"; requested: string | null; baseType: string | null };

const period = (profile: TypekeyProfile) => [profile.validFrom, profile.validUntil].filter(Boolean).join(" – ") || null;

function periodsOverlap(left: TypekeyProfile, right: TypekeyProfile) {
  const leftFrom = left.validFrom ? Date.parse(left.validFrom.replace(/\[.*\]$/, "")) : Number.NEGATIVE_INFINITY;
  const leftUntil = left.validUntil ? Date.parse(left.validUntil.replace(/\[.*\]$/, "")) : Number.POSITIVE_INFINITY;
  const rightFrom = right.validFrom ? Date.parse(right.validFrom.replace(/\[.*\]$/, "")) : Number.NEGATIVE_INFINITY;
  const rightUntil = right.validUntil ? Date.parse(right.validUntil.replace(/\[.*\]$/, "")) : Number.POSITIVE_INFINITY;
  if ([leftFrom, leftUntil, rightFrom, rightUntil].some(Number.isNaN)) return false;
  return leftFrom <= rightUntil && rightFrom <= leftUntil;
}

/**
 * A base type is only a reliable substitute when it is the same vehicle for every attribute BMW publishes.
 * A missing attribute on either side cannot be verified, so it counts as a difference.
 */
export function compareTypekeyProfiles(requested: TypekeyProfile, baseType: TypekeyProfile): { reliable: boolean; differences: TypekeyDifference[] } {
  const differences: TypekeyDifference[] = [];
  for (const attribute of COMPARED_ATTRIBUTES) {
    const left = requested.attributes[attribute];
    const right = baseType.attributes[attribute];
    if (left === undefined || right === undefined || left !== right) differences.push({ attribute, requested: left ?? null, baseType: right ?? null });
  }
  if (!periodsOverlap(requested, baseType)) differences.push({ attribute: "validity", requested: period(requested), baseType: period(baseType) });
  return { reliable: differences.length === 0, differences };
}
