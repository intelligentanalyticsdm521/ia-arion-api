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

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';

// Any PSI snapshots ever?
const psi = await pool.request().query(`
  SELECT run_date, strategy, performance_score, mobile_performance, desktop_performance,
         lcp_ms, triggered_by, created_at
  FROM arion.site_pagespeed_snapshot WHERE site_id = '${SITE}'
  ORDER BY created_at DESC
`);
console.log(`PSI snapshots for site (total: ${psi.recordset.length}):`);
console.table(psi.recordset);

// Recent platform events (look for site.defaults_applied + image_optim + plugin updates)
const events = await pool.request().query(`
  SELECT TOP 20 event_type, payload_json, created_at
  FROM platform.event_log WHERE event_ref_id = '${SITE}' OR
        JSON_VALUE(payload_json, '$.site_id') = '${SITE}'
  ORDER BY created_at DESC
`);
console.log("\nRecent platform events for site:");
console.table(events.recordset.map(e => ({ event_type: e.event_type, when: e.created_at, payload: (e.payload_json || '').slice(0, 100) })));

// Last few security events (just to confirm plugin is talking)
const sec = await pool.request().query(`
  SELECT TOP 5 event_type, occurred_at
  FROM arion.site_security_event WHERE site_id = '${SITE}'
  ORDER BY occurred_at DESC
`);
console.log("\nLast 5 security events (proves plugin is active):");
console.table(sec.recordset);

// Plugin status table
const status = await pool.request().query(`
  SELECT plugin_status, plugin_version, plugin_last_status_at
  FROM arion.site WHERE site_id = '${SITE}'
`);
console.log("\nCurrent plugin state:");
console.table(status.recordset);

await pool.close();
