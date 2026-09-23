import { config } from "../src/config.js";
import { db } from "../src/db/bmw.js";

for (const database of [config.BMW_SQL_DATABASE, config.BMW_SQL_DATAREQUEST_DATABASE]) {
  const pool = await db(database);
  const result = await pool.request().query("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION");
  console.log(JSON.stringify({ database, columns: result.recordset }, null, 2));
}
