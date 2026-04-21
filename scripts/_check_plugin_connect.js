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

const site = await pool.request().query(`
  SELECT site_id, domain, plugin_status, plugin_version, plugin_connected_at,
         plugin_last_status_at, site_token_last_rotated
  FROM arion.site WHERE site_id = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA'
`);
console.log("Site row:");
console.table(site.recordset);

const code = await pool.request().query(`
  SELECT code_id, created_at, expires_at, redeemed_at, redeemed_from_url
  FROM arion.site_provision_code
  WHERE site_id = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA'
  ORDER BY created_at DESC
`);
console.log("\nProvision codes (most recent first):");
console.table(code.recordset);

const events = await pool.request().query(`
  SELECT TOP 10 event_type, severity, title, occurred_at
  FROM arion.site_security_event
  WHERE site_id = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA'
  ORDER BY occurred_at DESC
`);
console.log("\nRecent security events:");
console.table(events.recordset);

const changes = await pool.request().query(`
  SELECT TOP 10 change_type, post_type, post_title, occurred_at
  FROM arion.site_content_change
  WHERE site_id = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA'
  ORDER BY occurred_at DESC
`);
console.log("\nRecent content changes:");
console.table(changes.recordset);

await pool.close();
