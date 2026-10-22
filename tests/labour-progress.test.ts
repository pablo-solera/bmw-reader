import { describe, expect, it } from "bun:test";
import { requestProgress, typekeyProgressFraction } from "../src/domain/labour/progress.js";

const progress = (stage: string, completed: number, total: number, previous: number | null = null, index = 0, count = 1) =>
  requestProgress(index, count, typekeyProgressFraction(stage, completed, total), previous);

describe("labour progress weighting", () => {
  it("never goes backwards across the catalog, flat-rates and AW sheet stages", () => {
    const events: Array<[string, number, number]> = [
      ["catalog", 1, 1], ["flat-rates-cache", 20, 34], ["flat-rates", 0, 14], ["flat-rates", 14, 14],
      ["aw-sheet-details", 0, 2785], ["aw-sheet-details", 1000, 2785], ["aw-sheet-details", 2785, 2785],
    ];
    let previous: number | null = null;
    const seen: number[] = [];
    for (const [stage, completed, total] of events) {
      previous = progress(stage, completed, total, previous);
      seen.push(previous);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBe(2);
    expect(seen.at(-1)).toBe(99);
  });

  it("keeps preparation stages small and leaves most of the range to AW sheets", () => {
    expect(progress("flat-rates", 34, 34)).toBe(10);
    expect(progress("aw-sheet-details", 0, 2785)).toBe(10);
    expect(progress("aw-sheet-details", 1393, 2785)).toBe(54);
    expect(progress("flat-rates", 29, 34)).toBeLessThan(10);
  });

  it("scales each typekey into its share of the request and keeps a stored higher value", () => {
    expect(progress("aw-sheet-details", 0, 100, null, 1, 4)).toBe(27);
    expect(progress("catalog", 1, 1, 40, 1, 4)).toBe(40);
    expect(progress("aw-sheet-details", 100, 100, null, 3, 4)).toBe(99);
  });

  it("ignores unknown stages and empty totals", () => {
    expect(typekeyProgressFraction("other", 5, 10)).toBe(0);
    expect(typekeyProgressFraction("aw-sheet-details", 0, 0)).toBeCloseTo(0.1);
  });
});
