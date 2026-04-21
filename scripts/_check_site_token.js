import sql from "mssql";
import crypto from "node:crypto";
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
const pluginUuid = "6dfb76a0-0d66-4385-b184-79e5726600e6";
const pluginUuidHash = crypto.createHash("sha256").update(pluginUuid).digest("hex");

const row = await pool.request().query(`
  SELECT site_id, domain, site_token_hash, site_token_last_rotated,
         plugin_status, plugin_version, plugin_connected_at, plugin_last_status_at
  FROM arion.site WHERE site_id = '${siteId}'
`);
console.log("Current site row:");
console.table(row.recordset);

console.log("\nPlugin's current UUID (hashed):", pluginUuidHash);
console.log("Matches ARION stored hash?    ", row.recordset[0]?.site_token_hash === pluginUuidHash ? "YES" : "NO");

const code = await pool.request().query(`
  SELECT code_id, created_at, redeemed_at, redeemed_from_url, revoked_at
  FROM arion.site_provision_code
  WHERE site_id = '${siteId}'
  ORDER BY created_at DESC
`);
console.log("\nProvision codes:");
console.table(code.recordset);

await pool.close();
