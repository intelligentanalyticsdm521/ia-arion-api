#!/usr/bin/env node
/** READ-ONLY: Briarwood's real monthly series — the "why" behind the score. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const r = await pool.request().query(`
  SELECT FORMAT(period_month,'yyyy-MM') ym, metric_key, value
  FROM arion.metric_monthly
  WHERE site_id='46F87A02-49E0-475C-8D4A-C88D536A0E7E' AND dimension IS NULL
    AND metric_key IN ('gsc_impressions','gsc_clicks','gsc_avg_position','gbp_impressions','gbp_calls','ga_sessions','kw_top10')
  ORDER BY metric_key, ym`);
const by = {};
for (const row of r.recordset) { (by[row.metric_key] ||= []).push(`${row.ym.slice(2)}:${Math.round(row.value)}`); }
for (const [k, v] of Object.entries(by)) console.log(k.padEnd(17), v.join('  '));
await pool.close();
