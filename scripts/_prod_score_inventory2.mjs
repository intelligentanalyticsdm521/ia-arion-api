#!/usr/bin/env node
/** READ-ONLY inventory pass 2 — correct column names + remaining ARION sources. */
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
    console.table(r.recordset.slice(0, 40));
    return r.recordset;
  } catch (e) { console.log(`\n### ${label}\n[ERR] ${e.message}`); return []; }
};

try {
  await q('arion.gsc_data by site+month', `
    SELECT site_id, FORMAT(report_date, 'yyyy-MM') ym, COUNT(*) rows_, SUM(clicks) clicks, SUM(impressions) impressions
    FROM arion.gsc_data GROUP BY site_id, FORMAT(report_date, 'yyyy-MM') ORDER BY site_id, ym`);
  await q('arion.site_page_view_daily by site+month', `
    SELECT site_id, FORMAT(day_utc, 'yyyy-MM') ym, SUM(view_count) views, SUM(unique_visitors) uniques
    FROM arion.site_page_view_daily GROUP BY site_id, FORMAT(day_utc, 'yyyy-MM') ORDER BY site_id, ym`);
  await q('arion.gbp_profile', `
    SELECT site_id, business_name, review_count, avg_rating, completeness_pct, last_synced_at FROM arion.gbp_profile`);
  await q('arion tables (all)', `
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='arion' ORDER BY TABLE_NAME`);
  await q('keyword-ish tables rowcounts', `
    SELECT t.name tbl, SUM(p.rows) rows_
    FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'arion' AND (t.name LIKE '%keyword%' OR t.name LIKE '%serank%' OR t.name LIKE '%rank%' OR t.name LIKE '%content%' OR t.name LIKE '%audit%' OR t.name LIKE '%security%' OR t.name LIKE '%vuln%')
    GROUP BY t.name ORDER BY t.name`);
  await q('site connection state', `
    SELECT s.site_id, s.domain,
      CASE WHEN s.gsc_oauth_token_ref IS NOT NULL THEN 1 ELSE 0 END has_gsc_token,
      CASE WHEN s.gbp_oauth_token_ref IS NOT NULL THEN 1 ELSE 0 END has_gbp_token,
      s.se_ranking_project_id
    FROM arion.site s WHERE s.domain IS NOT NULL`);
} finally { await pool.close(); }
