#!/usr/bin/env node
/** READ-ONLY: column check for the next SPARK/OLIVER detail reports
 *  (contract-linter rule: never SQL against assumed columns). */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
for (const [schema, tbl] of [['lumen','lead'],['lumen','email_event'],['lumen','automation'],['lumen','list'],['oliver','subscription']]) {
  const r = await pool.request().query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='${schema}' AND TABLE_NAME='${tbl}' ORDER BY ORDINAL_POSITION`);
  console.log(`${schema}.${tbl}: ${r.recordset.map((x) => x.COLUMN_NAME).join(', ') || '(MISSING)'}`);
}
await pool.close();
