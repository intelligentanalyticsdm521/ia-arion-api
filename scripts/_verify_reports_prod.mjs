#!/usr/bin/env node
/**
 * _verify_reports_prod.mjs — run the report builders against PRODUCTION data
 * and print what they actually produce, per site.
 *
 * Read-only. Fixtures prove the code runs; this proves it says something true
 * about a real site with real messy data — 115 pages, 162 files, Rank Math
 * configured on some sites and not others.
 *
 * Usage: node scripts/_verify_reports_prod.mjs [domain]
 */
import sql from 'mssql';
import { getArionMetrics } from '../lib/arionMetrics.js';
import { prodPool } from './_prodsql.mjs';

const ONLY = process.argv[2];
const WATCH = process.env.WATCH ? process.env.WATCH.split(',')
  : ['content_library', 'page_reachability', 'media_library', 'component_upkeep'];

const pool = await prodPool('iadm_services');
const sites = (await pool.request().query(
  `SELECT site_id, tenant_id, domain FROM arion.site ORDER BY domain`)).recordset
  .filter((s) => !ONLY || s.domain === ONLY);

for (const site of sites) {
  console.log(`\n══ ${site.domain} ══`);
  const out = await getArionMetrics(pool, site, 12);
  const detail = out.detail || {};

  for (const id of WATCH) {
    const rep = detail[id];
    if (!rep) { console.log(`  ${id.padEnd(20)} — not produced`); continue; }
    const items = rep.items || [];
    const withSeries = items.filter((i) => (i.series || []).filter((v) => v != null).length >= 2).length;
    console.log(`  ${id.padEnd(20)} ${String(items.length).padStart(4)} items, ${withSeries} with a 2+ point series`);
    // One real row, so the columns can be eyeballed rather than trusted.
    const s = items[0];
    if (s) console.log(`      e.g. ${JSON.stringify({ name: String(s.name).slice(0, 40), extra: s.extra }).slice(0, 250)}`);
  }

  const m = out.metrics || {};
  const live = ['content_avg_words', 'content_thin_ratio', 'content_orphan_ratio',
                'content_broken_links', 'media_library_mb', 'media_alt_coverage',
                'media_unused_count', 'content_rankmath_avg']
    .map((k) => {
      const v = (m[k] || []).filter((x) => x != null).slice(-1)[0];
      return v == null ? null : `${k}=${v}`;
    }).filter(Boolean);
  console.log(`  metrics: ${live.join('  ') || '(none)'}`);
}

await pool.close();
