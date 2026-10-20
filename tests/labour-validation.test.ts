import { describe, expect, test } from "bun:test";
import { ValidationError } from "reader-core/domain/errors";
import { validateLabourInput, baseExtractionDate } from "../src/domain/labour/validation.js";
import type { LabourInput } from "../src/domain/labour/types.js";
import { bmwSelectionSchema } from "../src/interfaces/http/openapi.js";
import { enqueueLabourUseCase, type EnqueueLabourDependencies } from "../src/application/use-cases/enqueue-labour.js";

const valid: LabourInput = {
  manufacturer: "BMW",
  series: "7'",
  date: "20261009",
  typekeys: [{ typekey: "11EH", family: "G70" }],
};

function invalidInput(patch: Partial<LabourInput>) {
  return { ...valid, ...patch } as LabourInput;
}

describe("BMW labour input validation", () => {
  test("accepts a valid request and normalizes each typekey series", () => {
    expect(validateLabourInput(valid)).toMatchObject({
      series: "7'",
      typekeys: [{ typekey: "11EH", family: "G70", series: "7" }],
    });
    expect(validateLabourInput({ ...valid, manufacturer: "MINI" }).manufacturer).toBe("MINI");
  });

  test("validates calendar dates rather than only their YYYYMMDD shape", () => {
    expect(baseExtractionDate("20240229").toISOString()).toBe("2024-02-29T00:00:00.000Z");
    for (const date of ["2026-10-09", "2026109", "20261301", "20260230", "20230229", "00500101"]) {
      expect(() => baseExtractionDate(date)).toThrow(ValidationError);
    }
  });

  test("rejects unsafe manufacturer and model path segments", () => {
    expect(() => validateLabourInput(invalidInput({ manufacturer: "AUDI" }))).toThrow("manufacturer must be BMW or MINI");
    for (const manufacturer of ["", ".", "..", "BMW/x", "BMW\\x"]) {
      expect(() => validateLabourInput(invalidInput({ manufacturer }))).toThrow(ValidationError);
    }
    for (const model of [".", "..", "../bucket", "model/name"]) {
      expect(() => validateLabourInput(invalidInput({ model }))).toThrow(ValidationError);
    }
    expect(() => validateLabourInput(invalidInput({ typekeys: [{ typekey: "11EH", family: "G70", model: "X/5" }] }))).toThrow(ValidationError);
  });

  test("restricts axCode and edition to path-safe identifiers", () => {
    for (const axCode of ["bad-code", "with space", "x/y"]) {
      expect(() => validateLabourInput(invalidInput({ axCode }))).toThrow("axCode may only contain letters, digits and underscores");
    }
    for (const edition of ["bad-code", "with space", "x/y"]) {
      expect(() => validateLabourInput(invalidInput({ edition }))).toThrow("edition may only contain letters, digits and underscores");
    }
  });

  test("requires one or more unique, well-formed typekeys and families", () => {
    for (const typekeys of [
      [],
      [{ typekey: "11eh", family: "G70" }],
      [{ typekey: "11E", family: "G70" }],
      [{ typekey: "11EHX", family: "G70" }],
      [{ typekey: "11-E", family: "G70" }],
      [{ typekey: "11EH", family: "g70" }],
      [{ typekey: "11EH", family: "G-70" }],
      [{ typekey: "11EH", family: "" }],
    ]) {
      expect(() => validateLabourInput(invalidInput({ typekeys: typekeys as LabourInput["typekeys"] }))).toThrow(ValidationError);
    }
    expect(() => validateLabourInput(invalidInput({ typekeys: [{ typekey: "11EH", family: "G70" }, { typekey: "11EH", family: "G70" }] }))).toThrow("Labour typekeys must be unique");
  });

  test("requires a series for every typekey, preferring and normalizing its own series", () => {
    expect(validateLabourInput({ ...valid, series: undefined, typekeys: [{ typekey: "11EH", series: "X'", family: "G70" }] }).typekeys[0]).toMatchObject({ series: "X" });
    expect(validateLabourInput({ ...valid, series: "7'", typekeys: [{ typekey: "11EH", family: "G70" }] }).typekeys[0]).toMatchObject({ series: "7" });
    expect(() => validateLabourInput({ ...valid, series: undefined, typekeys: [{ typekey: "11EH", family: "G70" }] })).toThrow(ValidationError);
    expect(() => validateLabourInput({ ...valid, series: undefined, typekeys: [{ typekey: "11EH", series: "'", family: "G70" }] })).toThrow(ValidationError);
  });

  test("model-options selections satisfy the same selection contract used for extraction", () => {
    expect(bmwSelectionSchema.parse({
      series: "7",
      date: "20261009",
      typekeys: [{ typekey: "11EH", family: "G70", model: "740i" }],
    })).toMatchObject({ series: "7", typekeys: [{ typekey: "11EH", family: "G70" }] });
    expect(() => bmwSelectionSchema.parse({ typekeys: [{ typekey: "11eh", family: "G70" }] })).toThrow();
    expect(() => bmwSelectionSchema.parse({ typekeys: [{ typekey: "11EH", family: "" }] })).toThrow();
  });

  test("does not claim paths, save state, or queue when the use case rejects bad data", async () => {
    const calls: string[] = [];
    const dependencies: EnqueueLabourDependencies = {
      getState: async () => { calls.push("get"); return null; },
      saveState: async state => { calls.push("save"); return state; },
      deleteState: async () => { calls.push("delete"); },
      claimTypekeyPaths: async () => { calls.push("claim"); return []; },
      releaseTypekeyPaths: async () => { calls.push("release"); },
      isCancelling: async () => false,
      queue: { add: async () => { calls.push("queue"); return { id: "job" }; }, getJob: async () => null },
      newId: () => "id",
      now: () => new Date("2026-10-09T00:00:00.000Z"),
    };
    await expect(enqueueLabourUseCase(invalidInput({ axCode: "bad-code" }), dependencies)).rejects.toThrow(ValidationError);
    await expect(enqueueLabourUseCase(invalidInput({ date: "20260230" }), dependencies)).rejects.toThrow(ValidationError);
    await expect(enqueueLabourUseCase(invalidInput({ typekeys: [] }), dependencies)).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });
});
