import { describe, expect, test } from "bun:test";
import type { ModelOptions } from "@solera/core-reader/contract/v1";
import { getTypekeyAvailabilityUseCase, parseTypekeyAvailabilityQuery, type GetTypekeyAvailabilityDependencies } from "../src/application/use-cases/get-typekey-availability.js";
import type { TypekeyAvailability } from "../src/application/use-cases/check-typekey-availability.js";
import { compareTypekeyProfiles, type TypekeyProfile } from "../src/domain/labour/typekey-profile.js";

const filters = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, values: [{ value }] }));
const f13 = { brand: "BMW", model: "M6", body: "COU", engine: "S63", eDrive: "-", electricMotor: "-", doors: "2", market: "EUR", steering: "RL" };
const details: Record<string, Record<string, string>> = {
  "6J02": { ...f13, transmission: "AUT" },
  "6J92": { ...f13, transmission: "MECH" },
  "6J03": { ...f13, transmission: "AUT" },
  "6J93": { ...f13, transmission: "AUT" },
  YM01: { ...f13, model: "650I", engine: "N63", body: "COU", transmission: "AUT", steering: "LL" },
  YM91: { ...f13, model: "650I", engine: "N63T", body: "COU", transmission: "MECH", steering: "LL" },
};
const listed = (typekey: string, baseType: string, extra: Record<string, unknown> = {}) => ({
  id: typekey, label: typekey, selection: {},
  attributes: { typekey, baseType, capacity: "4.395", power: "412", validFrom: "2015-03-01T00:00:00Z[UTC]", validUntil: "2017-10-31T00:00:00Z[UTC]", ...extra },
});

function dependencies(statuses: Record<string, TypekeyAvailability>, calls: string[] = []): GetTypekeyAvailabilityDependencies {
  return {
    check: async typekey => { calls.push(`check:${typekey}`); return statuses[typekey] ?? "available"; },
    modelOptions: async query => {
      if (query.filterByType) {
        calls.push(`details:${String(query.filterByType)}`);
        return { manufacturer: "BMW", appliedFilters: {}, filters: filters(details[String(query.filterByType)] ?? {}), models: [], complete: true } satisfies ModelOptions;
      }
      calls.push("listing");
      return {
        manufacturer: "BMW", appliedFilters: {}, filters: [], complete: false,
        models: [listed("6J02", "6J92"), listed("6J92", "6J92"), listed("6J03", "6J93"), listed("6J93", "6J93"), listed("YM01", "YM91", { validFrom: "2012-07-01T00:00:00Z[UTC]", validUntil: "2015-02-28T00:00:00Z[UTC]", power: "330" }), listed("YM91", "YM91", { validFrom: "2012-07-01T00:00:00Z[UTC]", validUntil: "2015-02-28T00:00:00Z[UTC]", power: "330" })],
      } satisfies ModelOptions;
    },
  };
}
const request = (typekey: string) => ({ brand: "BMW" as const, typekey, series: "6'", developmentCode: "F13", language: "en-GB" });

describe("strict base type comparison", () => {
  const profile = (overrides: Partial<TypekeyProfile["attributes"]> = {}, period: Pick<TypekeyProfile, "validFrom" | "validUntil"> = { validFrom: "2015-03-01T00:00:00Z[UTC]", validUntil: "2017-10-31T00:00:00Z[UTC]" }): TypekeyProfile => ({
    typekey: "X", attributes: { model: "M6", engine: "S63", body: "COU", transmission: "AUT", eDrive: "-", electricMotor: "-", doors: "2", market: "EUR", steering: "RL", capacity: "4.395", power: "412", ...overrides }, ...period,
  });

  test("is reliable only when every attribute and the production period match", () => {
    expect(compareTypekeyProfiles(profile(), profile())).toEqual({ reliable: true, differences: [] });
    for (const attribute of ["model", "engine", "body", "transmission", "eDrive", "electricMotor", "doors", "market", "steering", "capacity", "power"] as const) {
      const result = compareTypekeyProfiles(profile(), profile({ [attribute]: "different" }));
      expect(result.reliable).toBe(false);
      expect(result.differences).toEqual([{ attribute, requested: expect.any(String), baseType: "different" }]);
    }
  });

  test("treats an attribute BMW does not publish as a difference and compares production periods", () => {
    const missing = profile();
    delete missing.attributes.transmission;
    expect(compareTypekeyProfiles(profile(), missing).differences).toEqual([{ attribute: "transmission", requested: "AUT", baseType: null }]);
    const disjoint = compareTypekeyProfiles(profile(), profile({}, { validFrom: "2011-07-01T00:00:00Z[UTC]", validUntil: "2015-02-28T00:00:00Z[UTC]" }));
    expect(disjoint.differences).toEqual([{ attribute: "validity", requested: "2015-03-01T00:00:00Z[UTC] – 2017-10-31T00:00:00Z[UTC]", baseType: "2011-07-01T00:00:00Z[UTC] – 2015-02-28T00:00:00Z[UTC]" }]);
    expect(compareTypekeyProfiles(profile(), profile({}, { validFrom: "2017-10-31T00:00:00Z[UTC]" })).reliable).toBe(true);
  });
});

describe("typekey availability report", () => {
  test("does not look up base types for typekeys BMW can serve", async () => {
    const calls: string[] = [];
    expect(await getTypekeyAvailabilityUseCase(request("6J92"), dependencies({}, calls))).toEqual({ typekey: "6J92", status: "available", suggestedTypekey: null });
    expect(await getTypekeyAvailabilityUseCase(request("6J92"), dependencies({ "6J92": "unknown" }))).toEqual({ typekey: "6J92", status: "unknown", suggestedTypekey: null });
    expect(calls).toEqual(["check:6J92"]);
  });

  test("never suggests 6J92 for 6J02 because it is a manual gearbox while 6J02 is automatic", async () => {
    const report = await getTypekeyAvailabilityUseCase(request("6J02"), dependencies({ "6J02": "unavailable", "6J92": "available" }));
    expect(report).toEqual({
      typekey: "6J02", status: "unavailable", code: "CGWATB0085", suggestedTypekey: null,
      baseType: { typekey: "6J92", status: "available", reliable: false, differences: [{ attribute: "transmission", requested: "AUT", baseType: "MECH" }] },
    });
  });

  test("suggests the base type only when it is available and identical", async () => {
    const report = await getTypekeyAvailabilityUseCase(request("6J03"), dependencies({ "6J03": "unavailable", "6J93": "available" }));
    expect(report).toMatchObject({ status: "unavailable", suggestedTypekey: "6J93", baseType: { typekey: "6J93", status: "available", reliable: true, differences: [] } });
  });

  test("does not suggest an identical base type that BMW also cannot serve", async () => {
    const report = await getTypekeyAvailabilityUseCase(request("6J03"), dependencies({ "6J03": "unavailable", "6J93": "unavailable" }));
    expect(report).toMatchObject({ suggestedTypekey: null, baseType: { typekey: "6J93", status: "unavailable", reliable: true } });
    const unknown = await getTypekeyAvailabilityUseCase(request("6J03"), dependencies({ "6J03": "unavailable", "6J93": "unknown" }));
    expect(unknown.suggestedTypekey).toBeNull();
  });

  test("reports the engine, gearbox and power differences that make YM01 unsuitable as YM91", async () => {
    const report = await getTypekeyAvailabilityUseCase(request("YM01"), dependencies({ YM01: "unavailable", YM91: "unavailable" }));
    expect(report.suggestedTypekey).toBeNull();
    expect(report.baseType?.differences.map(item => item.attribute)).toEqual(["engine", "transmission"]);
  });

  test("returns no base type for typekeys that are their own base type or unknown to Vehicle Type Research", async () => {
    expect(await getTypekeyAvailabilityUseCase(request("6J92"), dependencies({ "6J92": "unavailable" }))).toEqual({ typekey: "6J92", status: "unavailable", code: "CGWATB0085", suggestedTypekey: null });
    expect(await getTypekeyAvailabilityUseCase(request("ZZ99"), dependencies({ ZZ99: "unavailable" }))).toEqual({ typekey: "ZZ99", status: "unavailable", code: "CGWATB0085", suggestedTypekey: null });
  });
});

describe("availability query parsing", () => {
  test("requires a valid typekey, series and development code and defaults the language", () => {
    expect(parseTypekeyAvailabilityQuery({ typekey: "YM13", series: "6'", developmentCode: "F13" })).toEqual({ brand: "BMW", typekey: "YM13", series: "6'", developmentCode: "F13", language: "en-GB" });
    expect(parseTypekeyAvailabilityQuery({ brand: "MINI", typekey: "XJ31", series: "F56", developmentCode: "F56" }).brand).toBe("MINI");
    expect(() => parseTypekeyAvailabilityQuery({ brand: "AUDI", typekey: "XJ31", series: "F56", developmentCode: "F56" })).toThrow();
    for (const query of [{}, { typekey: "ym13", series: "6'", developmentCode: "F13" }, { typekey: "YM13", developmentCode: "F13" }, { typekey: "YM13", series: "6'", developmentCode: "f13" }, { typekey: ["YM13", "6J02"], series: "6'", developmentCode: "F13" }]) {
      expect(() => parseTypekeyAvailabilityQuery(query)).toThrow();
    }
  });
});
