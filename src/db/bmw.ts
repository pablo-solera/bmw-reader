import sql from "mssql";
import { config } from "../config.js";

const pools = new Map<string, sql.ConnectionPool>();
export async function db(database = config.BMW_SQL_DATABASE) {
  if (!config.BMW_SQL_SERVER || !config.BMW_SQL_USER || !config.BMW_SQL_PASSWORD) throw new Error("BMW_SQL_SERVER, BMW_SQL_USER and BMW_SQL_PASSWORD are required");
  if (!config.allowedDatabases.includes(database)) throw new Error(`Database ${database} is not in BMW_SQL_ALLOWED_DATABASES`);
  let pool = pools.get(database);
  if (!pool || pool.connected === false) {
    pool = new sql.ConnectionPool({ server: config.BMW_SQL_SERVER, database, user: config.BMW_SQL_USER, password: config.BMW_SQL_PASSWORD,
      port: config.BMW_SQL_PORT, options: { encrypt: config.BMW_SQL_ENCRYPT === "true", trustServerCertificate: config.BMW_SQL_TRUST_SERVER_CERTIFICATE === "true" },
      connectionTimeout: config.BMW_SQL_CONNECTION_TIMEOUT_MS, requestTimeout: config.BMW_SQL_REQUEST_TIMEOUT_MS, pool: { max: 5, min: 0, idleTimeoutMillis: 30000 } });
    await pool.connect();
    pools.set(database, pool);
  }
  return pool;
}

export async function writeDb(database = config.BMW_SQL_DATABASE) {
  if (!config.confirmProduction) throw new Error("Set BMW_CONFIRM_PRODUCTION=true to enable SQL writes");
  if (!config.sqlSchemaVerified) throw new Error("Inspect the live BMW SQL schema and set BMW_SQL_SCHEMA_VERIFIED=true before enabling writes");
  return db(database);
}

export function quoteIdentifier(name: string) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `[${name}]`;
}
export function sqlType(name: string, length = 4000) { return name === "MAX" ? sql.NVarChar(sql.MAX) : sql.NVarChar(length); }

export async function withTransaction<T>(database: string, callback: (tx: sql.Transaction) => Promise<T>): Promise<T> {
  const connection = await writeDb(database);
  const tx = new sql.Transaction(connection);
  await tx.begin();
  try { const result = await callback(tx); await tx.commit(); return result; }
  catch (error) { await tx.rollback(); throw error; }
}
