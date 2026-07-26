#!/usr/bin/env node
/** READ-ONLY diagnosis: compare arion.site + arion.metric_monthly between the
 *  LOCAL dev DB (what Brandon's dev walk reads) and PROD (where the backfill
 *  landed). Explains why real reports don't show in the dev portal. */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const local = await new sql.ConnectionPool({
  server: devHost, port: devPort ? Number(devPort) : 1433,
  database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const prod = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const q = `
  SELECT s.site_id, s.tenant_id, s.domain,
         (SELECT COUNT(*) FROM arion.metric_monthly m WHERE m.site_id = s.site_id) AS metric_rows
  FROM arion.site s ORDER BY s.domain`;

for (const [name, pool] of [['LOCAL DEV', local], ['PROD', prod]]) {
  const rows = (await pool.request().query(q)).recordset;
  console.log(`\n═══ ${name} — ${rows.length} sites ═══`);
  for (const r of rows) {
    console.log(`  ${String(r.metric_rows).padStart(7)} rows  ${r.domain}  site=${r.site_id}  tenant=${r.tenant_id}`);
  }
  try {
    const b = (await pool.request().query(`SELECT COUNT(*) n FROM arion.ia_insights_benchmark`)).recordset[0].n;
    console.log(`  benchmarks: ${b} rows`);
  } catch (e) { console.log(`  benchmarks: TABLE MISSING (${e.message.split('\n')[0]})`); }
}
await local.close(); await prod.close();
