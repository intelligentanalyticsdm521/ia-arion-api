// One-off: reset arion.plugin_version seed rows from 2.1.0 → 1.0.0.
// 2.1.0 was a dev-only version that was never released. The first official
// production release is 1.0.0.
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

console.log("Before:");
console.table((await pool.request().query(`
  SELECT version_id, version, channel, blob_path, is_current
  FROM arion.plugin_version
  ORDER BY channel
`)).recordset);

const result = await pool.request().batch(`
  UPDATE arion.plugin_version
     SET version    = '1.0.0',
         changelog  = 'First official production release'
   WHERE version = '2.1.0';
`);

console.log("\nAfter:");
console.table((await pool.request().query(`
  SELECT version_id, version, channel, blob_path, is_current, changelog
  FROM arion.plugin_version
  ORDER BY channel
`)).recordset);

await pool.close();
console.log("✓ Plugin version reset to 1.0.0");
