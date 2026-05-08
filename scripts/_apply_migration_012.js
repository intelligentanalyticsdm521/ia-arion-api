import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { readFileSync } from "fs";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const migration = readFileSync("./db/migrations/012_pagespeed_crux_opportunities.sql", "utf8");

// Split on GO or just run the whole thing — file uses IF NOT EXISTS so it's safe
const statements = migration.split(/\n--+/);
console.log("Applying migration 012...");

// Run as single batch — SQL Server handles IF NOT EXISTS gracefully
await pool.request().batch(migration);
console.log("✓ Migration 012 applied");

// Verify columns exist now
const cols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot'
  ORDER BY ORDINAL_POSITION
`);
console.log("\nFinal column list on arion.site_pagespeed_snapshot:");
console.table(cols.recordset);

await pool.close();
