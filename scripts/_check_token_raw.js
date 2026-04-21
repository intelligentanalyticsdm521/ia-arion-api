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

const siteId = "64C43F2F-B4FE-40C2-B023-0F06F7D275FA";
const row = await pool.request().query(`
  SELECT
    site_id,
    domain,
    CASE WHEN site_token_raw IS NULL THEN 'NULL'
         WHEN site_token_raw = '' THEN 'EMPTY'
         ELSE 'SET (first 8: ' + LEFT(site_token_raw, 8) + ', len ' + CAST(LEN(site_token_raw) AS VARCHAR) + ')'
    END AS raw_status,
    LEFT(site_token_hash, 12) AS hash_prefix,
    site_token_last_rotated,
    plugin_status,
    plugin_version
  FROM arion.site WHERE site_id = '${siteId}'
`);
console.log("Token state:");
console.table(row.recordset);

// Now test calling the plugin with this token via the actual pluginClient logic
const token_raw = await pool.request().query(`SELECT site_token_raw FROM arion.site WHERE site_id = '${siteId}'`);
const rawToken = token_raw.recordset[0]?.site_token_raw;
if (rawToken) {
  console.log("\n--- Probing plugin /status endpoint with raw token ---");
  try {
    const res = await fetch("https://intelligentanalyticsdm.com/wp-json/intelligent-analytics/v1/status", {
      headers: { "X-Arion-Site-Token": rawToken, Accept: "application/json" },
    });
    console.log("HTTP", res.status);
    const body = await res.text();
    console.log(body.slice(0, 500));
  } catch (err) {
    console.log("fetch error:", err.message);
  }
}

await pool.close();
