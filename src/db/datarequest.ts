import { config } from "../config.js";
import { db, quoteIdentifier } from "./bmw.js";
import type { ExtractionInput } from "../types.js";

export type ResolvedRequest = ExtractionInput & { typekeys: string[]; serie?: string };
export async function resolveDataRequest(id: string): Promise<ResolvedRequest> {
  const database = config.BMW_SQL_DATAREQUEST_DATABASE;
  const pool = await db(database);
  const request = await pool.request().input("id", id).query(`SELECT TOP (1) * FROM ${quoteIdentifier("dbo")}.${quoteIdentifier("Request")} WHERE id = @id`);
  const row = request.recordset[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`DataRequestBMW.Request id ${id} was not found`);
  const typekeys = String(row.ModelDesignation ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!typekeys.length) throw new Error(`Request ${id} has no ModelDesignation typekeys`);
  const model = String(row.Model ?? "");
  const manufacturer = String(row.Manufacturer ?? "BMW");
  const family = String(row.DevelopmentCode ?? "");
  const axCode = String(row.AxCode ?? "");
  const edition = String(row.Edition ?? "");
  const typed = pool.request();
  for (const [i, typekey] of typekeys.entries()) typed.input(`tk${i}`, typekey);
  const vehicleResult = await typed.query(`SELECT * FROM ${quoteIdentifier("dbo")}.${quoteIdentifier("ModelVehicle")} WHERE typeKey IN (${typekeys.map((_, i) => `@tk${i}`).join(",")})`);
  const first = vehicleResult.recordset[0] as Record<string, unknown> | undefined;
  if (!first) throw new Error(`No ModelVehicle rows found for request ${id}`);
  const resolved = {
    dataRequestId: id, manufacturer: String(first.Manufacturer ?? manufacturer), series: String(first.Serie ?? ""), model,
    family: String(first.DevelopmentCode ?? family), axCode, edition, typekeys,
  };
  return resolved;
}
