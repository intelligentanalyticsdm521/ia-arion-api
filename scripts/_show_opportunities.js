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
const r = await pool.request().query(`
  SELECT TOP 1 strategy, performance_score, lcp_ms, fcp_ms, tbt_ms, opportunities
  FROM arion.site_pagespeed_snapshot
  WHERE site_id = '${SITE}' AND strategy = 'mobile'
  ORDER BY created_at DESC
`);

const row = r.recordset[0];
if (!row) { console.log("No mobile snapshot"); process.exit(0); }

console.log(`Mobile run: score=${row.performance_score}, LCP=${row.lcp_ms}ms, FCP=${row.fcp_ms}ms, TBT=${row.tbt_ms}ms`);
console.log("\nLighthouse opportunities (sorted by estimated savings):");
const opps = JSON.parse(row.opportunities || '[]');
for (const op of opps.slice(0, 10)) {
  const savings = op.numeric_value ? `~${Math.round(op.numeric_value)}${op.numeric_unit || 'ms'}` : '?';
  console.log(`  • ${op.title}`);
  console.log(`    estimated savings: ${savings}  ${op.display_value || ''}`);
}

await pool.close();
