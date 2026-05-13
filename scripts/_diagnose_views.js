import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log("=== View definitions ===");
const views = await pool.request().query(`
  SELECT v.name AS view_name, m.definition
  FROM sys.views v
  JOIN sys.schemas s ON s.schema_id = v.schema_id
  JOIN sys.sql_modules m ON m.object_id = v.object_id
  WHERE s.name = 'arion'
  ORDER BY v.name
`);
for (const v of views.recordset) {
  console.log(`\n--- arion.${v.view_name} ---`);
  console.log(v.definition);
}

console.log("\n\n=== Try selecting from each view ===");
for (const v of views.recordset) {
  try {
    await pool.request().query(`SELECT TOP 1 * FROM arion.${v.view_name}`);
    console.log(`✓ arion.${v.view_name} — query works`);
  } catch (err) {
    console.log(`✗ arion.${v.view_name} — ERROR: ${err.message}`);
  }
}

await pool.close();
