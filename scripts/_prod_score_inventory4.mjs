#!/usr/bin/env node
/** READ-ONLY: why did client sites return 0 SE Ranking rows? Distribution probe. */
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
  try { const r = await pool.request().query(query); console.log(`\n### ${label} (${r.recordset.length})`); console.table(r.recordset.slice(0, 50)); }
  catch (e) { console.log(`\n### ${label}\n[ERR] ${e.message}`); }
};
try {
  await q('rows by site + competitor null/not', `
    SELECT site_id,
           CASE WHEN competitor_domain IS NULL THEN 'own' ELSE 'competitor' END kind,
           COUNT(*) n, COUNT(DISTINCT keyword) kws,
           MIN(recorded_for) first_d, MAX(recorded_for) last_d
    FROM arion.se_ranking_position_history
    GROUP BY site_id, CASE WHEN competitor_domain IS NULL THEN 'own' ELSE 'competitor' END
    ORDER BY site_id, kind`);
  await q('position value distribution (own rows)', `
    SELECT site_id,
           SUM(CASE WHEN position IS NULL THEN 1 ELSE 0 END) null_pos,
           SUM(CASE WHEN position = 0 THEN 1 ELSE 0 END) zero_pos,
           SUM(CASE WHEN position BETWEEN 1 AND 100 THEN 1 ELSE 0 END) ranked_1_100,
           SUM(CASE WHEN position > 100 THEN 1 ELSE 0 END) over_100
    FROM arion.se_ranking_position_history
    WHERE competitor_domain IS NULL
    GROUP BY site_id`);
  await q('months per site (own, ranked)', `
    SELECT site_id, FORMAT(recorded_for,'yyyy-MM') ym, COUNT(DISTINCT keyword) kws
    FROM arion.se_ranking_position_history
    WHERE competitor_domain IS NULL AND position BETWEEN 1 AND 100
    GROUP BY site_id, FORMAT(recorded_for,'yyyy-MM') ORDER BY site_id, ym`);
} finally { await pool.close(); }
