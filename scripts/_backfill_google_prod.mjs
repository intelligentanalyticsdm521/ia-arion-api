#!/usr/bin/env node
/**
 * PROD DATA BACKFILL — Phases 2-4 (Brandon authorized 2026-07-25).
 * GSC (~16 mo) + GA4 (~14 mo) + GBP Performance (~18 mo) → arion.metric_monthly
 * for all four prod sites, via lib/insightsSnapshot.js (the same code the
 * monthly refresh endpoint uses). MERGE-idempotent; re-runs are safe.
 *
 * Run from C:\dev\iadm\arion-api:  node scripts/_backfill_google_prod.mjs
 */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { snapshotGoogleSources } from '../lib/insightsSnapshot.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  requestTimeout: 120000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

try {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain, gbp_oauth_token_ref, gsc_oauth_token_ref,
           gsc_site_url, ga4_property_id, gbp_location_name, se_ranking_project_id
    FROM arion.site WHERE domain IS NOT NULL`)).recordset;

  const { aggregateBacklinksMonthly } = await import('../lib/insightsSnapshot.js');
  for (const site of sites) {
    console.log(`\n══ ${site.domain} ══`);
    const bl = await aggregateBacklinksMonthly(pool, site);
    if (bl) console.log(`  backlinks: ${bl} row(s) aggregated`);
    const out = await snapshotGoogleSources(pool, site, { gbpKeywordMonths: 6, log: (m) => console.log(`  · ${m}`) });
    for (const [src, r] of Object.entries(out)) {
      console.log(`  ${src}: pulled ${r.pulled} row(s)${r.upserted != null ? `, upserted ${r.upserted}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
    }
  }

  const v = await pool.request().query(`
    SELECT s.domain, m.source, COUNT(DISTINCT m.period_month) months, COUNT(*) rows_
    FROM arion.metric_monthly m JOIN arion.site s ON s.site_id = m.site_id
    GROUP BY s.domain, m.source ORDER BY s.domain, m.source`);
  console.log('\n=== metric_monthly by site × source ===');
  console.table(v.recordset);
} finally {
  await pool.close();
}
