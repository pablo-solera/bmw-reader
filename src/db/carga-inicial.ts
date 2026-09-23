import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonRecord } from "../types.js";
import sql from "mssql";
import { writeDb, withTransaction } from "./bmw.js";
import { config } from "../config.js";

export type InitialFileKind = "modelSeries" | "developmentCode" | "typekey";
export type InitialFile = { kind: InitialFileKind; file: string; rows: JsonRecord[] };
const object = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const arr = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : [];

export function parseInitialFile(file: string, value: unknown): InitialFile {
  const payload = object(value);
  if (Array.isArray(payload.typekeys)) return { kind: "developmentCode", file, rows: arr(payload.typekeys) };
  if (payload.availableFilters && typeof payload.availableFilters === "object") {
    const filters = payload.availableFilters as JsonRecord;
    if (filters.developmentCode) return { kind: "modelSeries", file, rows: arr(filters.developmentCode) };
    return { kind: "typekey", file, rows: Object.entries(filters).flatMap(([field, values]) => arr(values).map(row => ({ field, ...row }))) };
  }
  if (payload.modelSeries) return { kind: "modelSeries", file, rows: arr(payload.modelSeries) };
  if (Array.isArray(value)) return { kind: "modelSeries", file, rows: arr(value) };
  throw new Error(`Unrecognized cargaInicial JSON structure: ${file}`);
}

export async function scanInitialDirectory(root: string) {
  const files: InitialFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        const content = await readFile(file, "utf8");
        files.push(parseInitialFile(file, JSON.parse(content)));
      }
    }
  }
  await walk(root);
  return files;
}

function str(value: unknown) { return value == null ? "" : String(value); }
const FILTER_TABLES = ["model", "body", "engine", "electricMotor", "market", "steering", "transmission"] as const;

export async function loadInitialDirectory(root: string) {
  if (!config.confirmProduction) throw new Error("Set BMW_CONFIRM_PRODUCTION=true before cargaInicial SQL writes");
  const files = await scanInitialDirectory(root);
  await writeDb(config.BMW_SQL_DATABASE);
  const counts: Record<string, number> = { developmentCode: 0, typekeys: 0, filters: 0 };
  await withTransaction(config.BMW_SQL_DATABASE, async tx => {
    for (const file of files.filter(value => value.kind === "modelSeries")) {
      const series = path.basename(file.file, path.extname(file.file));
      const brand = path.basename(path.dirname(path.dirname(file.file)));
      const lookup = new sql.Request(tx).input("series", sql.NVarChar(100), series).input("brand", sql.NVarChar(100), brand);
      const model = await lookup.query("SELECT TOP (1) ms.searchTerm FROM dbo.modelSeries ms JOIN dbo.brand b ON b.id=ms.idBrand WHERE ms.searchTerm=@series AND (b.searchTerm=@brand OR b.displayTerm=@brand)");
      if (!model.recordset[0]) throw new Error(`No seeded BMW_Labour.modelSeries entry for ${brand}/${series}`);
      for (const row of file.rows) {
        const insert = new sql.Request(tx).input("series", sql.NVarChar(100), series).input("search", sql.NVarChar(250), str(row.searchTerm)).input("display", sql.NVarChar(1000), str(row.displayTerm));
        await insert.query("IF NOT EXISTS (SELECT 1 FROM dbo.developmentCode WHERE idModelSeries=@series AND searchTerm=@search) INSERT dbo.developmentCode (idModelSeries,searchTerm,displayTerm) VALUES (@series,@search,@display)");
        counts.developmentCode++;
      }
    }
    for (const file of files.filter(value => value.kind === "developmentCode")) {
      const developmentCode = path.basename(file.file, path.extname(file.file));
      const query = new sql.Request(tx).input("code", sql.NVarChar(100), developmentCode).query("SELECT TOP (1) id FROM dbo.developmentCode WHERE searchTerm=@code ORDER BY id DESC");
      const found = (await query).recordset[0] as { id: number } | undefined;
      if (!found) throw new Error(`No BMW_Labour.developmentCode row found for ${developmentCode}`);
      for (const row of file.rows) {
        const typekey = str(row.typekey);
        if (!typekey) continue;
        const request = new sql.Request(tx).input("development", sql.Int, found.id).input("typekey", sql.NVarChar(20), typekey)
          .input("baseType", sql.NVarChar(20), str(row.baseType)).input("capacity", sql.NVarChar(50), str(row.capacity))
          .input("capacityUnit", sql.NVarChar(30), str(row.capacityUnit)).input("power", sql.NVarChar(50), str(row.power))
          .input("powerUnit", sql.NVarChar(30), str(row.powerUnit)).input("validFrom", sql.NVarChar(50), str(row.validFrom))
          .input("validUntil", sql.NVarChar(50), str(row.validUntil));
        await request.query("IF NOT EXISTS (SELECT 1 FROM dbo.typekeys WHERE idDevelopmentCode=@development AND typekey=@typekey) INSERT dbo.typekeys (idDevelopmentCode,typekey,baseType,capacity,capacityUnit,power,powerUnit,validFrom,validUntil) VALUES (@development,@typekey,@baseType,@capacity,@capacityUnit,@power,@powerUnit,@validFrom,@validUntil)");
        counts.typekeys++;
      }
    }
    for (const file of files.filter(value => value.kind === "typekey")) {
      const typekey = path.basename(file.file, path.extname(file.file));
      const result = await new sql.Request(tx).input("typekey", sql.NVarChar(20), typekey).query("SELECT TOP (1) id FROM dbo.typekeys WHERE typekey=@typekey ORDER BY id DESC");
      const found = result.recordset[0] as { id: number } | undefined;
      if (!found) continue;
      for (const row of file.rows) {
        const field = str(row.field);
        if (!FILTER_TABLES.includes(field as typeof FILTER_TABLES[number])) continue;
        const insert = new sql.Request(tx).input("id", sql.Int, found.id).input("search", sql.NVarChar(250), str(row.searchTerm)).input("display", sql.NVarChar(1000), str(row.displayTerm));
        await insert.query(`IF NOT EXISTS (SELECT 1 FROM dbo.[${field}] WHERE idtypekey=@id AND searchTerm=@search) INSERT dbo.[${field}] (idtypekey,searchTerm,displayTerm) VALUES (@id,@search,@display)`);
        counts.filters++;
      }
    }
  });
  return counts;
}
