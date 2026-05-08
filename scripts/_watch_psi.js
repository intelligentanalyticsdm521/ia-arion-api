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
const startTime = new Date();

console.log(`Watching for new PSI rows after ${startTime.toISOString()}...`);
console.log("(checking every 15s for 3 min)\n");

for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 15000));
  const result = await pool.request().query(`
    SELECT strategy, performance_score, lcp_ms, triggered_by, created_at
    FROM arion.site_pagespeed_snapshot
    WHERE site_id = '${SITE}' AND created_at > '${startTime.toISOString()}'
    ORDER BY created_at DESC
  `);
  const elapsed = Math.round((Date.now() - startTime.getTime()) / 1000);
  if (result.recordset.length > 0) {
    console.log(`[+${elapsed}s] ✓ NEW ROWS DETECTED:`);
    console.table(result.recordset);
    console.log("\nProduction MI works. Apply IA Defaults flow is functional end-to-end.");
    break;
  } else {
    console.log(`[+${elapsed}s] no new rows yet...`);
  }
}

await pool.close();
