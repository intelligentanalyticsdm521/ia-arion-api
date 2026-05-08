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

console.log("Current snapshots for the site:");
const rows = await pool.request().query(`
  SELECT run_date, strategy, performance_score, mobile_performance, desktop_performance,
         lcp_ms, triggered_by, created_at
  FROM arion.site_pagespeed_snapshot WHERE site_id = '${SITE}' ORDER BY created_at DESC
`);
console.table(rows.recordset);

// Drop the old unique constraint and re-create including strategy
console.log("\nDropping old UQ_pagespeed_site_date constraint...");
await pool.request().batch(`
  IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_pagespeed_site_date' AND type = 'UQ')
    ALTER TABLE arion.site_pagespeed_snapshot DROP CONSTRAINT UQ_pagespeed_site_date;
`);
console.log("✓ Dropped (if existed)");

console.log("Creating new unique constraint including strategy...");
await pool.request().batch(`
  IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_pagespeed_site_date_strategy' AND type = 'UQ')
    ALTER TABLE arion.site_pagespeed_snapshot
    ADD CONSTRAINT UQ_pagespeed_site_date_strategy UNIQUE (tenant_id, site_id, run_date, strategy);
`);
console.log("✓ New constraint created on (tenant_id, site_id, run_date, strategy)");

await pool.close();
