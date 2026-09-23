import sql from "mssql";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { flattenCatalog } from "../transform/catalog.js";
import { flattenFlatrates } from "../transform/flatrates.js";
import type { CatalogEntry } from "../types.js";
import { quoteIdentifier, withTransaction } from "./bmw.js";
import { readRawTypekey } from "../bmw/fetch-typekey.js";
import type { ExtractionInput } from "../types.js";

const safe = (value: unknown) => value == null ? null : String(value);
async function insertRows(tx: sql.Transaction, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]!);
  const sqlTable = new sql.Table(`dbo.${table}`); sqlTable.create = false;
  for (const col of columns) sqlTable.columns.add(col, sql.NVarChar(sql.MAX), { nullable: true });
  for (const row of rows) sqlTable.rows.add(...columns.map(col => row[col] == null ? null : String(row[col])));
  await new sql.Request(tx).bulk(sqlTable);
}

export async function loadTypekeys(input: ExtractionInput, date = new Date()) {
  const prepared = [] as Array<{ typekey: string; catalog: Record<string, unknown>[]; rates: Record<string, unknown>[] }>;
  for (const typekey of input.typekeys) {
    const raw = await readRawTypekey(input, typekey, date);
    const catalog = flattenCatalog(typekey, raw.catalog as CatalogEntry[]).map(row => ({ typekey: row.typekey, id: row.id, number: row.number, text: row.text, entriesId: row.entriesId, entriesNumber: row.entriesNumber, entriesText: row.entriesText }));
    const rates = [...raw.groups.values()].flatMap(groups => flattenFlatrates(typekey, groups)).flatMap(row => (row.catalogPaths.length ? row.catalogPaths : [""]).map(catalogPath => ({
      typekeyIdEntriesId: row.typekeyIdEntriesId, catalogPaths: catalogPath, containsValidityExpression: safe(row.containsValidityExpression),
      klammerText: row.klammerText, lackFlaeche: safe(row.lackFlaeche), lackStufe: safe(row.lackStufe), orderNumber: row.orderNumber,
      rubrikText: row.rubrikText, solrId: row.solrId, sonderAw: safe(row.sonderAw), text: row.text, valid: safe(row.valid),
      flatrates_awSheetOID: safe(row.flatrate.awSheetOID), flatrates_displayType: safe(row.flatrate.displayType), flatrates_hasInklusivPositionen: safe(row.flatrate.hasInklusivPositionen),
      flatrates_hasUmfasstTexte: safe(row.flatrate.hasUmfasstTexte), flatrates_klammerText: safe(row.flatrate.klammerText), flatrates_lackFlaeche: safe(row.flatrate.lackFlaeche),
      flatrates_lackStufe: safe(row.flatrate.lackStufe), flatrates_lackwertMetallic: safe(row.flatrate.lackwertMetallic), flatrates_lackwertUni: safe(row.flatrate.lackwertUni),
      flatrates_number: safe(row.flatrate.number), flatrates_ruestwert: safe(row.flatrate.ruestwert), flatrates_sonderAw: safe(row.flatrate.sonderAw), flatrates_tcRelevant: safe(row.flatrate.tcRelevant),
      flatrates_text: safe(row.flatrate.text), flatrates_validFrom: safe(row.flatrate.validFrom), flatrates_validityExpression: safe(row.flatrate.validityExpression),
      flatrates_value: safe(row.flatrate.value), flatrates_workType: safe(row.flatrate.workType),
    })));
    prepared.push({ typekey, catalog, rates });
  }
  await withTransaction(config.BMW_SQL_DATABASE, async tx => {
    const typekeys = input.typekeys;
    const placeholders = typekeys.map((_, i) => `@t${i}`).join(",");
    for (const table of ["typekeyCatalog", "typekeyIdEntriesId"]) {
      const del = new sql.Request(tx);
      typekeys.forEach((typekey, i) => del.input(`t${i}`, typekey));
      await del.query(`DELETE FROM dbo.${quoteIdentifier(table)} WHERE ${quoteIdentifier(table === "typekeyCatalog" ? "typekey" : "typekeyIdEntriesId")} IN (${placeholders})`);
    }
    for (const item of prepared) {
      await insertRows(tx, "typekeyCatalog", item.catalog);
      await insertRows(tx, "typekeyIdEntriesId", item.rates);
    }
  });
}

export async function recordPetition(input: ExtractionInput, requestId: string, status: string, s3Path?: string) {
  const pool = await (await import("./bmw.js")).writeDb(config.BMW_SQL_DATABASE);
  const result = await pool.request()
    .input("group", sql.NVarChar(100), input.group ?? "BMW").input("manufacturer", sql.NVarChar(100), input.manufacturer)
    .input("model", sql.NVarChar(200), input.model).input("family", sql.NVarChar(100), input.family)
    .input("types", sql.NVarChar(sql.MAX), input.typekeys.join(",")).input("state", sql.NVarChar(50), status)
    .input("edition", sql.NVarChar(50), input.edition).input("requestId", sql.NVarChar(100), requestId)
    .input("s3server", sql.NVarChar(500), config.S3_ENDPOINT ?? "").input("bucket", sql.NVarChar(255), config.S3_BUCKET)
    .input("path", sql.NVarChar(1000), s3Path ?? "").input("startTime", sql.NVarChar(50), String(Date.now()))
    .query(`IF EXISTS (SELECT 1 FROM dbo.Peticiones WHERE requestId=@requestId) UPDATE dbo.Peticiones SET state=@state,S3_server=@s3server,S3_bucket=@bucket,S3_path=@path WHERE requestId=@requestId ELSE INSERT dbo.Peticiones ([group],manufacturer,model,family,types,state,Edicion,requestId,startTime,S3_server,S3_bucket,S3_path) VALUES (@group,@manufacturer,@model,@family,@types,@state,@edition,@requestId,@startTime,@s3server,@bucket,@path); SELECT SCOPE_IDENTITY() AS id`);
  return result.recordset[0]?.id as number | undefined;
}

export async function savePivotSafe(input: ExtractionInput, rows: import("../types.js").PivotRow[]) {
  const table = `${input.axCode}_${input.edition}`;
  quoteIdentifier(table);
  const pool = await (await import("./bmw.js")).writeDb(config.BMW_SQL_DATABASE);
  const columnDefs = [
    "typekeyCatalog_id nvarchar(max)", "typekeyCatalog_number nvarchar(10)", "typekeyCatalog_text nvarchar(250)",
    "typekeyCatalog_entriesId nvarchar(250)", "typekeyCatalog_entriesNumber nvarchar(250)", "typekeyCatalog_entriesText nvarchar(250)",
    "typekeyIdEntriesId_catalogPaths nvarchar(max)", "typekeyIdEntriesId_rubrikText nvarchar(250)", "typekeyIdEntriesId_text nvarchar(250)",
    "typekeyIdEntriesId_flatrates_awSheetOID nvarchar(250)", "typekeyIdEntriesId_flatrates_number nvarchar(250)",
    "typekeyIdEntriesId_flatrates_text nvarchar(250)", "typekeyIdEntriesId_flatrates_workType nvarchar(250)",
    "typekeyIdEntriesId_flatrates_klammerText nvarchar(250)", "orderNumber nvarchar(50)",
    ...input.typekeys.map(typekey => `${quoteIdentifier(`type_${typekey}`)} nchar(10)`),
  ];
  const rawTableName = table.replace(/'/g, "''");
  await pool.request().query(`IF OBJECT_ID(N'dbo.${rawTableName}', N'U') IS NULL CREATE TABLE dbo.${quoteIdentifier(table)} (${columnDefs.join(",")})`);
  await withTransaction(config.BMW_SQL_DATABASE, async tx => {
    await new sql.Request(tx).query(`DELETE FROM dbo.${quoteIdentifier(table)}`);
    await new sql.Request(tx).input("table", sql.NVarChar(128), table).query("DELETE FROM dbo.nomCamposTabla WHERE NomTable=@table");
    const sqlRows = rows.map(row => ({ ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "values")), ...Object.fromEntries(input.typekeys.map(typekey => [`type_${typekey}`, row.values[typekey] ?? null])) }));
    await insertRows(tx, table, sqlRows);
    for (const [index, typekey] of input.typekeys.entries()) {
      const request = new sql.Request(tx).input("brand", sql.NVarChar(100), input.manufacturer).input("model", sql.NVarChar(200), input.model).input("table", sql.NVarChar(128), table).input("type", sql.NVarChar(100), typekey).input("order", sql.Int, index + 1);
      await request.query("INSERT dbo.nomCamposTabla (brand,Model,NomTable,nomCampo,Orden,nomCampoVisible,visible) VALUES (@brand,@model,@table,@type,@order,@type,'1')");
    }
  });
}

export async function readDdaRows() {
  const pool = await (await import("./bmw.js")).db(config.BMW_SQL_DATABASE);
  const result = await pool.request().query("SELECT Operacion, Tiempo FROM dbo.RegistrosQ WHERE Operacion <> 'KN' ORDER BY Operacion");
  const rows = result.recordset as Array<{ Operacion: string; Tiempo: number | string }>;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.Operacion, (counts.get(row.Operacion) ?? 0) + 1);
  return rows.filter(row => counts.get(row.Operacion) === 1);
}

export type SpecialDetail = { awSheetOID: string; kind: "umfassttexte" | "inklusivpositionen"; type: string; payload: unknown };
export async function writeSpecialDetails(details: SpecialDetail[]) {
  if (!details.length) return;
  await withTransaction(config.BMW_SQL_DATABASE, async tx => {
    for (const detail of details) {
      const serialized = JSON.stringify(detail.payload, null, 2);
      const md5 = createHash("md5").update(serialized, "utf8").digest("hex");
      const request = new sql.Request(tx)
        .input("oid", sql.NVarChar(100), detail.awSheetOID).input("kind", sql.NVarChar(40), detail.kind)
        .input("md5", sql.NVarChar(32), md5).input("type", sql.NVarChar(300), detail.type)
        .input("origin", sql.NVarChar(sql.MAX), serialized).input("visible", sql.NVarChar(sql.MAX), serialized);
      await request.query("IF NOT EXISTS (SELECT 1 FROM dbo.LoRaro WHERE awSheetOID=@oid AND Tipo=@kind AND Md5=@md5) INSERT dbo.LoRaro (awSheetOID,Tipo,Md5,Type,Origen,TxtVisible) VALUES (@oid,@kind,@md5,@type,@origin,@visible)");
    }
  });
}

export async function readRequestRows(dataRequestId: string) {
  const pool = await (await import("./bmw.js")).db(config.BMW_SQL_DATAREQUEST_DATABASE);
  const request = await pool.request().input("id", sql.NVarChar(100), dataRequestId)
    .query("SELECT TOP (1) * FROM dbo.Request WHERE id=@id");
  const row = request.recordset[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`DataRequestBMW.Request id ${dataRequestId} was not found`);
  const typekeys = String(row.ModelDesignation ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const typed = pool.request();
  typekeys.forEach((typekey, index) => typed.input(`t${index}`, sql.NVarChar(100), typekey));
  const result = typekeys.length ? await typed.query(`SELECT * FROM dbo.ModelVehicle WHERE typeKey IN (${typekeys.map((_, i) => `@t${i}`).join(",")})`) : { recordset: [] };
  return { request: row, vehicles: result.recordset as Record<string, unknown>[] };
}

export async function readPivotRows(tableName: string, typekeys: string[]) {
  const table = quoteIdentifier(tableName);
  const pool = await (await import("./bmw.js")).db(config.BMW_SQL_DATABASE);
  const request = pool.request();
  const result = await request.query(`SELECT [typekeyIdEntriesId_flatrates_number],${typekeys.map(typekey => quoteIdentifier(`type_${typekey}`)).join(",")} FROM dbo.${table}`);
  return result.recordset as Array<Record<string, string | null>>;
}
