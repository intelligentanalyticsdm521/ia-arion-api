#!/usr/bin/env node
/** READ-ONLY: arion.ia_insights_benchmark schema + current rows. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const cols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='ia_insights_benchmark' ORDER BY ORDINAL_POSITION`);
console.table(cols.recordset);
const rows = await pool.request().query(`SELECT TOP 30 * FROM arion.ia_insights_benchmark`);
console.log(`rows: ${rows.recordset.length}`);
console.table(rows.recordset.slice(0, 20));
const cats = await pool.request().query(`
  SELECT tenant_id, setting_value FROM core.tenant_settings WHERE setting_key='service_category'`).catch(() => ({ recordset: [] }));
console.log('tenant service categories:', JSON.stringify(cats.recordset ?? []));
await pool.close();
