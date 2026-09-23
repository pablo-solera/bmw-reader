import { expect, test } from "bun:test";
import { parseInitialFile } from "../src/db/carga-inicial.js";

test("recognizes typekey details with available filters", () => {
  const parsed = parseInitialFile("UD42.json", { availableFilters: { model: [{ searchTerm: "X5", displayTerm: "X5" }] } });
  expect(parsed.kind).toBe("typekey");
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.rows[0]).toMatchObject({ field: "model", searchTerm: "X5" });
});

test("recognizes development-code file with typekeys", () => {
  const parsed = parseInitialFile("X.json", { typekeys: [{ typekey: "UD42", baseType: "UD42" }] });
  expect(parsed.kind).toBe("developmentCode");
  expect(parsed.rows[0]?.typekey).toBe("UD42");
});
