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

// Plugin inventory
const inv = await pool.request().query(`
  SELECT TOP 20 plugin_name, current_version, update_available, is_active, captured_at
  FROM arion.site_plugin_inventory WHERE site_id = '${SITE}'
  ORDER BY captured_at DESC, plugin_name
`);
console.log("Plugin inventory (latest):");
console.table(inv.recordset);

// PageSpeed snapshots
const psi = await pool.request().query(`
  SELECT TOP 10 run_date, strategy, performance_score, lcp_ms, inp_ms, cls_score, triggered_by
  FROM arion.site_pagespeed_snapshot WHERE site_id = '${SITE}'
  ORDER BY run_date DESC, created_at DESC
`);
console.log("\nPageSpeed snapshots:");
console.table(psi.recordset);

// Plugin update log
const upd = await pool.request().query(`
  SELECT TOP 10 update_type, target, status, started_at, completed_at, error_message
  FROM arion.site_plugin_update_log WHERE site_id = '${SITE}'
  ORDER BY started_at DESC
`);
console.log("\nUpdate log:");
console.table(upd.recordset);

await pool.close();
