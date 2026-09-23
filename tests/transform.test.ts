import { describe, expect, test } from "bun:test";
import { flattenCatalog } from "../src/transform/catalog.js";
import { buildPivot, flattenFlatrates, findAwSheetGroups } from "../src/transform/flatrates.js";
import { extractSpecialEquipment, workTypeLabel } from "../src/transform/worktype.js";
import { ddaMismatch, ddaRule, normalizeOperation } from "../src/transform/dda.js";
import { quoteIdentifier } from "../src/db/bmw.js";
import { fetchAwSheetDetails } from "../src/bmw/fetch-typekey.js";

describe("BMW catalogue and labour transforms", () => {
  test("fetches both awSheet details even when typekey flags are false", async () => {
    const calls: string[] = [];
    const written: Array<{ key: string; value: unknown }> = [];
    const result = await fetchAwSheetDetails({
      async inklusivPositionen(typekey, oid) { calls.push(`inclusive:${typekey}:${oid}`); return [{ number: "1" }]; },
      async umfasstTexte(typekey, oid) { calls.push(`surrounding:${typekey}:${oid}`); return []; },
    }, "UD42", "oid-1", new Set(["11", "12"]), "root", async (key, value) => { written.push({ key, value }); });
    expect(calls).toEqual(["inclusive:UD42:oid-1", "surrounding:UD42:oid-1"]);
    expect(result).toMatchObject({ inclusiveCount: 1, umfasstCount: 0 });
    expect(written).toEqual([
      { key: "root/11/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
      { key: "root/12/oid-1_inklusivpositionen.json", value: [{ number: "1" }] },
    ]);
  });
  test("flattens nested catalogue entries", () => {
    expect(flattenCatalog("UD42", [{ id: "hg", number: "11", text: "Engine", entries: [{ id: "a_b", number: "01", text: "Oil" }] }])).toEqual([
      { typekey: "UD42", id: "hg", number: "11", text: "Engine", entriesId: "a_b", entriesNumber: "01", entriesText: "Oil" },
    ]);
  });
  test("preserves all catalog paths, displayType and flatrate values", () => {
    const rows = flattenFlatrates("UD42", [{ catalogPaths: ["entry_a", "entry_b"], orderNumber: "1", flatrates: [{ awSheetOID: "123", displayType: "DEFAULT", number: "0000001", value: 8, validityExpression: "true" }] }]);
    expect(rows[0]?.catalogPaths).toEqual(["entry_a", "entry_b"]);
    expect(rows[0]?.flatrate).toMatchObject({ displayType: "DEFAULT", value: 8 });
  });
  test("pivots rates across types using each path without LIKE wildcards", () => {
    const catalog = new Map([["UD42", flattenCatalog("UD42", [{ id: "h", number: "11", text: "Engine", entries: [{ id: "entry_a", number: "1", text: "Oil" }] }])]]);
    const rates = new Map([["UD42", flattenFlatrates("UD42", [{ catalogPaths: ["path_entry_a%00"], rubrikText: "Engine", flatrates: [{ awSheetOID: "123", number: "0000001", value: 8, workType: "HAUPTARBEIT" }] }])]]);
    const pivot = buildPivot(catalog, rates);
    expect(pivot).toHaveLength(1);
    expect(pivot[0]?.values).toEqual({ UD42: "8" });
  });
  test("does not confuse entries that share a prefix", () => {
    const catalog = new Map([["UD42", flattenCatalog("UD42", [{ id: "h", number: "11", text: "Engine", entries: [{ id: "entry_a", number: "1", text: "Oil" }] }])]]);
    const rates = new Map([["UD42", flattenFlatrates("UD42", [{ catalogPaths: ["prefix_entry_ab%00"], flatrates: [{ awSheetOID: "123", number: "0000001", value: 8 }] }])]]);
    expect(buildPivot(catalog, rates)).toHaveLength(0);
  });
  test("deduplicates awSheet OIDs while recording every HG", () => {
    const result = findAwSheetGroups(new Map([["11", [{ flatrates: [{ awSheetOID: "x" }] }]], ["12", [{ flatrates: [{ awSheetOID: "x" }] }]]]));
    expect([...result.get("x")!]).toEqual(["11", "12"]);
  });
});

describe("legacy-compatible BMW comparison helpers", () => {
  test("quotes only simple SQL identifiers", () => {
    expect(quoteIdentifier("J01_20250121")).toBe("[J01_20250121]");
    expect(() => quoteIdentifier("J01]; DROP TABLE Peticiones;--")).toThrow();
  });
  test("translates known work types and retains special-equipment suffix", () => {
    expect(workTypeLabel("HAUPTARBEIT S5AC")).toBe("T.P. S5AC");
    expect(workTypeLabel("VERBUNDARBEIT")).toBe("T.A.");
    expect(workTypeLabel("PLUSARBEIT")).toBe("P.P");
  });
  test("extracts Sonderausstattung code", () => {
    expect(extractSpecialEquipment("Sonderausstattung ('S5AC')")).toBe("S5AC");
  });
  test("normalizes DDA operations and applies exact, inclusive and ZAX rules", () => {
    expect(normalizeOperation("51 76 546) ZAX")).toBe("5176546");
    expect(ddaRule("51 76 546")).toBe("exact");
    expect(ddaMismatch("51 76 546", 5, 6)).toBe(true);
    expect(ddaMismatch("51 76 546)", 5, 6)).toBe(false);
    expect(ddaMismatch("51 76 546)", 6, 6)).toBe(true);
    expect(ddaMismatch("51 76 546 ZAX", 5, 6)).toBe(true);
    expect(ddaMismatch("51 76 546 ZAX", 5, "")).toBe(false);
  });
});
