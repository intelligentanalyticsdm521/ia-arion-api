#!/usr/bin/env node
/** READ-ONLY inventory pass 3 — SE Ranking history shape + remaining snapshots. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const q = async (label, query) => {
  try {
    const r = await pool.request().query(query);
    console.log(`\n### ${label} (${r.recordset.length} rows)`);
    console.table(r.recordset.slice(0, 60));
    return r.recordset;
  } catch (e) { console.log(`\n### ${label}\n[ERR] ${e.message}`); return []; }
};

try {
  await q('se_ranking_position_history columns', `
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='se_ranking_position_history' ORDER BY ORDINAL_POSITION`);
  await q('se_ranking_backlink_snapshot columns', `
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='se_ranking_backlink_snapshot' ORDER BY ORDINAL_POSITION`);
  await q('gbp_insights columns + rowcount', `
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='gbp_insights' ORDER BY ORDINAL_POSITION`);
  await q('gbp_insights volume', `SELECT COUNT(*) n FROM arion.gbp_insights`);
  await q('site_ga4_snapshot volume', `SELECT COUNT(*) n FROM arion.site_ga4_snapshot`);
  await q('site_analytics_snapshot volume', `SELECT COUNT(*) n FROM arion.site_analytics_snapshot`);
  await q('site_health volume', `SELECT COUNT(*) n FROM arion.site_health`);
  await q('site_form_submission volume by month', `
    SELECT tenant_id, FORMAT(created_at,'yyyy-MM') ym, COUNT(*) n FROM arion.site_form_submission
    GROUP BY tenant_id, FORMAT(created_at,'yyyy-MM') ORDER BY tenant_id, ym`);
} finally { await pool.close(); }
