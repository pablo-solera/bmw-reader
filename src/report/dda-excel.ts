import ExcelJS from "exceljs";
import { ddaMismatch, normalizeOperation } from "../transform/dda.js";

export type DdaValueRow = { typekey: string; bmwValue: string | null };
export async function buildDdaWorkbook(rows: Array<{ Operacion: string; Tiempo: number | string }>, typekeys: string[], pivotValues: Map<string, Map<string, string>>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("DDA contra BMW");
  sheet.addRow([]);
  sheet.addRow([]);
  sheet.addRow(["Nº Operacion", "DDA", "", ...typekeys]);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    const operation = row.Operacion.trim();
    const values = pivotValues.get(normalizeOperation(operation));
    const output = [operation, row.Tiempo, "", ...typekeys.map(typekey => values?.get(typekey) ?? "")];
    const excelRow = sheet.addRow(output);
    typekeys.forEach((typekey, i) => {
      const value = values?.get(typekey);
      if (ddaMismatch(operation, row.Tiempo, value)) excelRow.getCell(i + 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
    });
  }
  sheet.columns.forEach((column, index) => { column.width = index < 2 ? 20 : 14; });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
