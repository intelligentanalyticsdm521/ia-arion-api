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

const migration = readFileSync("./db/migrations/041_arion_site_ga4_measurement_id.sql", "utf8");

console.log("Applying migration 041 (arion.site.ga4_measurement_id)...");

// Split on GO — mssql .batch() doesn't handle standalone GO markers in a
// mixed-batch file, so we split ourselves.
const batches = migration.split(/^\s*GO\s*$/gm).map(b => b.trim()).filter(Boolean);
for (let i = 0; i < batches.length; i++) {
  await pool.request().batch(batches[i]);
  console.log(`[migrate 041] batch ${i + 1}/${batches.length} ok`);
}
console.log("✓ Migration 041 applied");

// Verify the column exists
const cols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site' AND COLUMN_NAME='ga4_measurement_id'
`);
console.log("\nga4_measurement_id column on arion.site:");
console.table(cols.recordset);

await pool.close();
