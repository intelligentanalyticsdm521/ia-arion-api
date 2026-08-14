#!/usr/bin/env node
/**
 * _inventory_captured_data.mjs — what are we ACTUALLY capturing, per source?
 *
 * Read-only. Before expanding an integration it is worth knowing exactly what
 * it already stores, because "we should capture more" is cheap to say and the
 * useful version of it is a list of the specific fields that are missing.
 *
 * Prints every metric key in arion.metric_monthly grouped by source, plus row
 * counts for the standalone integration tables.
 *
 * Usage: node scripts/_inventory_captured_data.mjs
 */
import { prodPool } from './_prodsql.mjs';

const pool = await prodPool('iadm_services');

const big = await pool.request().query(`
  SELECT TOP 8 t.name, rows_ = SUM(p.rows)
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
   WHERE s.name = 'arion'
   GROUP BY t.name ORDER BY SUM(p.rows) DESC`);
console.log('LARGEST ARION TABLES');
for (const r of big.recordset) console.log(`  ${r.name.padEnd(32)} ${String(r.rows_).padStart(9)}`);

const m = await pool.request().query(`
  SELECT source, metric_key,
         rows_ = COUNT(*),
         sites = COUNT(DISTINCT site_id),
         dims  = COUNT(DISTINCT dimension_value),
         newest = MAX(period_month)
    FROM arion.metric_monthly
   GROUP BY source, metric_key
   ORDER BY source, metric_key`);

console.log(`\nMETRIC_MONTHLY — ${m.recordset.length} distinct metric keys`);
let src = null;
for (const r of m.recordset) {
  if (r.source !== src) { src = r.source; console.log(`\n  ── source: ${src || '(null)'}`); }
  console.log(`     ${String(r.metric_key).padEnd(34)} ${String(r.rows_).padStart(7)} rows  ` +
              `${r.sites} site(s)  ${String(r.dims).padStart(4)} dim value(s)  newest ${String(r.newest).slice(0, 10)}`);
}

console.log('\nSTANDALONE INTEGRATION TABLES');
for (const t of ['gsc_data', 'se_ranking_position_history', 'se_ranking_backlink_snapshot',
                 'se_ranking_summary', 'site_pagespeed_snapshot', 'business_location',
                 'site_ga4_snapshot', 'site_search_console_snapshot', 'site_analytics_snapshot']) {
  try {
    const r = await pool.request().query(`SELECT n = COUNT(*) FROM arion.${t}`);
    console.log(`  ${t.padEnd(34)} ${String(r.recordset[0].n).padStart(8)}`);
  } catch { console.log(`  ${t.padEnd(34)}   (missing)`); }
}

await pool.close();
