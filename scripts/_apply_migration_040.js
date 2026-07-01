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

const migration = readFileSync("./db/migrations/040_site_page_view_rollup.sql", "utf8");

console.log("Applying migration 040 (arion.site_page_view_daily)...");

// Split on GO — mssql .batch() doesn't handle standalone GO markers in a
// mixed-batch file, so we split ourselves.
const batches = migration.split(/^\s*GO\s*$/gm).map(b => b.trim()).filter(Boolean);
for (let i = 0; i < batches.length; i++) {
  await pool.request().batch(batches[i]);
  console.log(`[migrate 040] batch ${i + 1}/${batches.length} ok`);
}
console.log("✓ Migration 040 applied");

// Verify the rollup table exists with expected columns
const cols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_page_view_daily'
  ORDER BY ORDINAL_POSITION
`);
console.log("\nColumns on arion.site_page_view_daily:");
console.table(cols.recordset);

await pool.close();
