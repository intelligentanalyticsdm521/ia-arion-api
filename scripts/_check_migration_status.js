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

// Spot-check critical columns from each recent migration
const checks = [
  { mig: '011_site_token_raw', table: 'arion.site', col: 'site_token_raw' },
  { mig: '012_pagespeed', table: 'arion.site_pagespeed_snapshot', col: 'triggered_by' },
];

for (const c of checks) {
  const [schema, table] = c.table.split('.');
  const r = await pool.request()
    .input('schema', schema)
    .input('table', table)
    .input('col', c.col)
    .query(`SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND COLUMN_NAME = @col`);
  const present = r.recordset[0].c > 0;
  console.log(`${present ? '✓' : '✗'} migration ${c.mig}: ${c.table}.${c.col} ${present ? 'present' : 'MISSING'}`);
}

await pool.close();
