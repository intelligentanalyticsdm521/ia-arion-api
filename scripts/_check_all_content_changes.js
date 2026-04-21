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

// ALL content changes with all fields
const changes = await pool.request().query(`
  SELECT TOP 20 post_id, change_type, post_title, post_url, word_count, occurred_at, received_at
  FROM arion.site_content_change
  WHERE site_id = '${siteId}'
  ORDER BY occurred_at DESC
`);
console.log("All recent content changes (full detail):");
console.table(changes.recordset);

// ALL security events
const events = await pool.request().query(`
  SELECT TOP 20 event_type, severity, title, occurred_at
  FROM arion.site_security_event
  WHERE site_id = '${siteId}'
  ORDER BY occurred_at DESC
`);
console.log("\nAll recent security events:");
console.table(events.recordset);

// Platform events (raw event log) — look for arion.* events in last hour
const plat = await pool.request().query(`
  SELECT TOP 30 event_type, event_ref_id, created_at, source_product
  FROM arion.platform_event
  WHERE event_type LIKE 'arion.%'
    AND created_at > DATEADD(hour, -1, SYSDATETIMEOFFSET())
  ORDER BY created_at DESC
`);
console.log("\nPlatform events in last hour:");
console.table(plat.recordset);

await pool.close();
