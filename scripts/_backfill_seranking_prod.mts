#!/usr/bin/env npx tsx
/**
 * PROD DATA BACKFILL — Phase 1 (Brandon authorized 2026-07-25: "the backfill
 * of production data you can do"; no code deploys until Aug 6).
 *
 * 1. Applies migration 046 (arion.metric_monthly — IF NOT EXISTS, additive).
 * 2. Pulls 12 months of SE Ranking position history for ALL FOUR sites
 *    (every engine, every keyword, unranked days stored as NULL position —
 *    mirroring the existing capture job's shape) and inserts the rows that
 *    aren't already there (NOT EXISTS on UQ_pos_history_daily's key).
 * 3. Aggregates arion.metric_monthly from the merged DB truth: kw_tracked /
 *    kw_top3 / kw_top10 / kw_top30 per month (primary engine = the engine
 *    with the most rows per site) + per-keyword monthly avg position as
 *    dimension rows (metric_key 'kw_position', dimension 'keyword').
 *
 * Writes ONLY: arion.metric_monthly + arion.se_ranking_position_history.
 * History inserts are NOT-EXISTS additive; metric rows are MERGE-idempotent
 * (re-runs refresh only the seranking-derived aggregate rows this script
 * owns). No DELETE anywhere; no UPDATE outside that MERGE.
 *
 * Run from C:\dev\iadm\arion-api:  npx tsx scripts/_backfill_seranking_prod.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const SITES = [
  { name: 'Intelligent Analytics', tenantId: '8C9527B9-8999-4B31-A306-F3D4CCC39FBD', siteId: '64C43F2F-B4FE-40C2-B023-0F06F7D275FA', projectId: 2465230 },
  { name: 'Rolling In It', tenantId: '12839687-67FA-4144-A152-1219D1A64901', siteId: '4E3B2AE2-4133-4813-84AA-4196661ED6F9', projectId: 12497786 },
  { name: 'Briarwood Dental', tenantId: '45E93346-DBA9-48D5-802B-A4E09A1B03A9', siteId: '46F87A02-49E0-475C-8D4A-C88D536A0E7E', projectId: 2671555 },
  { name: 'Midwest Ag Services', tenantId: '777C1093-F725-424B-8293-E6881190C40C', siteId: 'CFE34569-780C-4548-8F06-CFC27EBC69B7', projectId: 2688562 },
];

// ── SE Ranking key (existing repo pattern; value never printed) ────────────
const verifySrc = fs.readFileSync(new URL('./_verify_seranking_rii.mjs', import.meta.url), 'utf8');
const SR_KEY = verifySrc.match(/SR_KEY = '([0-9a-f]{20,})'/)![1];
const api = async (p: string) => {
  const r = await fetch(`https://api4.seranking.com${p}`, { headers: { Authorization: `Token ${SR_KEY}` } });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── prod pool ──────────────────────────────────────────────────────────────
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  requestTimeout: 120000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const now = new Date();
const dateFrom = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
const dateTo = now.toISOString().slice(0, 10);

try {
  // ── 1. migration 046 (IF NOT EXISTS guarded) ─────────────────────────────
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const mig = fs.readFileSync(path.join(__dir, '..', 'db', 'migrations', '046_metric_monthly.sql'), 'utf8');
  for (const batch of mig.split(/^\s*GO\s*$/mi)) {
    const b = batch.trim();
    if (b) await pool.request().batch(b);
  }
  const check = await pool.request().query(`SELECT COUNT(*) n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='metric_monthly'`);
  console.log(`[mig 046] metric_monthly present: ${check.recordset[0].n === 1}`);

  // ── 2. position history backfill ─────────────────────────────────────────
  for (const s of SITES) {
    const engines: any[] = await api(`/sites/${s.projectId}/positions?date_from=${dateFrom}&date_to=${dateTo}&with_landing_pages=0`);
    type Row = { engineId: string; kwId: string; kw: string; date: string; pos: number | null };
    const rows: Row[] = [];
    for (const eng of engines) {
      const engineId = String(eng.site_engine_id);
      for (const kw of eng.keywords || []) {
        const kwId = String(kw.id);
        const kwName = String(kw.name || '').slice(0, 400);
        for (const pt of kw.positions || []) {
          const date = String(pt.date || '');
          if (!date || date < dateFrom) continue;
          const p = Number(pt.pos ?? pt.position);
          rows.push({ engineId, kwId, kw: kwName, date, pos: isFinite(p) && p >= 1 && p <= 200 ? p : null });
        }
      }
    }
    console.log(`\n[${s.name}] API rows: ${rows.length} across ${engines.length} engines`);

    let inserted = 0;
    const BATCH = 120;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const req = pool.request();
      req.input('tid', sql.UniqueIdentifier, s.tenantId);
      req.input('sid', sql.UniqueIdentifier, s.siteId);
      req.input('proj', sql.NVarChar(40), String(s.projectId));
      const values = chunk.map((r, j) => {
        req.input(`e${j}`, sql.NVarChar(40), r.engineId);
        req.input(`k${j}`, sql.NVarChar(40), r.kwId);
        req.input(`w${j}`, sql.NVarChar(400), r.kw);
        req.input(`d${j}`, sql.Date, r.date);
        req.input(`p${j}`, sql.Int, r.pos);
        return `(@e${j}, @k${j}, @w${j}, @d${j}, @p${j})`;
      }).join(',');
      const res = await req.query(`
        INSERT INTO arion.se_ranking_position_history
          (tenant_id, site_id, se_project_id, site_engine_id, keyword_id, keyword, competitor_domain, position, recorded_for, recorded_at)
        SELECT @tid, @sid, @proj, v.eng, v.kid, v.kw, NULL, v.pos, v.d, SYSDATETIMEOFFSET()
        FROM (VALUES ${values}) v(eng, kid, kw, d, pos)
        WHERE NOT EXISTS (
          SELECT 1 FROM arion.se_ranking_position_history h
          WHERE h.tenant_id = @tid AND h.site_id = @sid AND h.site_engine_id = v.eng
            AND h.keyword_id = v.kid AND h.competitor_domain IS NULL AND h.recorded_for = v.d
        )`);
      inserted += res.rowsAffected[0] || 0;
    }
    console.log(`[${s.name}] inserted ${inserted} new history rows (rest already present)`);
  }

  // ── 3. metric_monthly aggregation from the merged DB truth ──────────────
  for (const s of SITES) {
    // primary engine = most captured rows for this site
    const pe = await pool.request().input('sid', sql.UniqueIdentifier, s.siteId).query(`
      SELECT TOP 1 site_engine_id FROM arion.se_ranking_position_history
      WHERE site_id=@sid AND competitor_domain IS NULL
      GROUP BY site_engine_id ORDER BY COUNT(*) DESC`);
    const engineId = pe.recordset[0]?.site_engine_id;
    if (!engineId) { console.log(`[${s.name}] no history rows — skipping metrics`); continue; }

    const res = await pool.request()
      .input('tid', sql.UniqueIdentifier, s.tenantId)
      .input('sid', sql.UniqueIdentifier, s.siteId)
      .input('eng', sql.NVarChar(40), engineId)
      .query(`
        WITH kwMonth AS (
          SELECT DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1) pm,
                 keyword_id, MAX(keyword) kw,
                 AVG(CAST(position AS float)) avg_pos   -- NULL when never ranked that month
          FROM arion.se_ranking_position_history
          WHERE site_id=@sid AND site_engine_id=@eng AND competitor_domain IS NULL
          GROUP BY DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1), keyword_id
        ), agg AS (
          SELECT pm, 'kw_tracked' mk, CAST(NULL AS nvarchar(40)) dim, CAST(NULL AS nvarchar(200)) dimv, CAST(COUNT(*) AS decimal(18,4)) v FROM kwMonth GROUP BY pm
          UNION ALL SELECT pm, 'kw_top3',  NULL, NULL, SUM(CASE WHEN avg_pos <= 3  THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
          UNION ALL SELECT pm, 'kw_top10', NULL, NULL, SUM(CASE WHEN avg_pos <= 10 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
          UNION ALL SELECT pm, 'kw_top30', NULL, NULL, SUM(CASE WHEN avg_pos <= 30 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
          UNION ALL SELECT pm, 'kw_position', 'keyword', LEFT(kw, 200), CAST(avg_pos AS decimal(18,4)) FROM kwMonth WHERE avg_pos IS NOT NULL
        )
        MERGE arion.metric_monthly AS tgt
        USING (SELECT @tid tenant_id, @sid site_id, pm, 'seranking' src, mk, dim, dimv, v FROM agg) AS src
          ON tgt.site_id = src.site_id AND tgt.period_month = src.pm AND tgt.metric_key = src.mk
             AND ISNULL(tgt.dimension,'~') = ISNULL(src.dim,'~') AND ISNULL(tgt.dimension_value,'~') = ISNULL(src.dimv,'~')
        WHEN MATCHED THEN UPDATE SET value = src.v, captured_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (tenant_id, site_id, period_month, source, metric_key, dimension, dimension_value, value)
          VALUES (src.tenant_id, src.site_id, src.pm, src.src, src.mk, src.dim, src.dimv, src.v);`);
    console.log(`[${s.name}] metric_monthly upserted rows: ${res.rowsAffected.reduce((a, b) => a + b, 0)} (engine ${engineId})`);
  }

  // ── verification ─────────────────────────────────────────────────────────
  const v = await pool.request().query(`
    SELECT s.domain, COUNT(DISTINCT m.period_month) months, COUNT(*) rows_
    FROM arion.metric_monthly m JOIN arion.site s ON s.site_id = m.site_id
    GROUP BY s.domain ORDER BY s.domain`);
  console.log('\n=== metric_monthly per site ===');
  console.table(v.recordset);
} finally {
  await pool.close();
}
