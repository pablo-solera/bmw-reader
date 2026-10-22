import { ValidationError } from "reader-core/domain/errors";
import type { ModelOptions } from "reader-core/contract/v1";
import { TYPEKEY_UNAVAILABLE_CODE } from "../../domain/labour/errors.js";
import { COMPARED_ATTRIBUTES, compareTypekeyProfiles, type TypekeyDifference, type TypekeyProfile } from "../../domain/labour/typekey-profile.js";
import type { TypekeyAvailability } from "./check-typekey-availability.js";

export type GetTypekeyAvailabilityDependencies = {
  modelOptions(query: Record<string, unknown>): Promise<ModelOptions>;
  check(typekey: string, language: string): Promise<TypekeyAvailability>;
};

export type TypekeyAvailabilityReport = {
  typekey: string;
  status: TypekeyAvailability;
  code?: string;
  baseType?: { typekey: string; status: TypekeyAvailability; reliable: boolean; differences: TypekeyDifference[] };
  suggestedTypekey: string | null;
};

type TypekeyRequest = { typekey: string; series: string; developmentCode: string; language: string };

const text = (value: unknown) => typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;

async function loadProfile(request: TypekeyRequest, typekey: string, dependencies: GetTypekeyAvailabilityDependencies): Promise<TypekeyProfile | undefined> {
  const [listing, details] = await Promise.all([
    dependencies.modelOptions({ manufacturer: "BMW", brand: "BMW", modelSeries: request.series, developmentCode: request.developmentCode, language: request.language }),
    dependencies.modelOptions({ manufacturer: "BMW", filterByType: typekey, language: request.language }),
  ]);
  const listed = listing.models.find(model => model.id === typekey);
  if (!listed) return undefined;
  const attributes: TypekeyProfile["attributes"] = {};
  for (const attribute of COMPARED_ATTRIBUTES) {
    if (attribute === "capacity" || attribute === "power") {
      const value = text(listed.attributes[attribute]);
      if (value !== undefined) attributes[attribute] = value;
      continue;
    }
    const values = details.filters.find(filter => filter.name === attribute)?.values ?? [];
    if (values.length === 1) attributes[attribute] = values[0]!.value;
  }
  return { typekey, baseType: text(listed.attributes.baseType), attributes, validFrom: text(listed.attributes.validFrom), validUntil: text(listed.attributes.validUntil) };
}

export async function getTypekeyAvailabilityUseCase(request: TypekeyRequest, dependencies: GetTypekeyAvailabilityDependencies): Promise<TypekeyAvailabilityReport> {
  const status = await dependencies.check(request.typekey, request.language);
  if (status !== "unavailable") return { typekey: request.typekey, status, suggestedTypekey: null };
  const report: TypekeyAvailabilityReport = { typekey: request.typekey, status, code: TYPEKEY_UNAVAILABLE_CODE, suggestedTypekey: null };

  const requested = await loadProfile(request, request.typekey, dependencies);
  const baseTypekey = requested?.baseType;
  if (!requested || !baseTypekey || baseTypekey === request.typekey) return report;

  const base = await loadProfile(request, baseTypekey, dependencies);
  const baseStatus = await dependencies.check(baseTypekey, request.language);
  const comparison = base ? compareTypekeyProfiles(requested, base) : { reliable: false, differences: [] as TypekeyDifference[] };
  report.baseType = { typekey: baseTypekey, status: baseStatus, reliable: comparison.reliable, differences: comparison.differences };
  if (baseStatus === "available" && comparison.reliable) report.suggestedTypekey = baseTypekey;
  return report;
}

export function parseTypekeyAvailabilityQuery(query: Record<string, unknown>): TypekeyRequest {
  const read = (name: string) => {
    const value = query[name];
    if (value !== undefined && typeof value !== "string") throw new ValidationError(`${name} must be provided exactly once`);
    return value;
  };
  const typekey = read("typekey");
  const series = read("series");
  const developmentCode = read("developmentCode");
  const language = read("language") ?? "en-GB";
  if (!typekey || !/^[A-Z0-9]{4}$/.test(typekey)) throw new ValidationError("typekey must be four characters [A-Z0-9]");
  if (!series) throw new ValidationError("series is required");
  if (!developmentCode || !/^[A-Z0-9]+$/.test(developmentCode)) throw new ValidationError("developmentCode must be [A-Z0-9]+");
  if (!language) throw new ValidationError("language must not be empty");
  return { typekey, series, developmentCode, language };
}
