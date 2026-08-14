#!/usr/bin/env node
/**
 * _check_integration_freshness.mjs — when did each integration last write?
 *
 * Read-only. Expanding what an integration captures is wasted effort if the
 * integration is not running, and a stale table looks identical to a healthy
 * one until someone asks for the date.
 *
 * Usage: node scripts/_check_integration_freshness.mjs
 */
import { prodPool } from './_prodsql.mjs';

const pool = await prodPool('iadm_services');
const today = new Date().toISOString().slice(0, 10);
console.log(`today is ${today}\n`);

const m = await pool.request().query(`
  SELECT source,
         newest_period = MAX(period_month),
         last_written  = MAX(captured_at),
         rows_         = COUNT(*)
    FROM arion.metric_monthly
   GROUP BY source ORDER BY source`);

console.log('metric_monthly by source');
console.log(`  ${'source'.padEnd(12)} ${'newest period'.padEnd(14)} ${'last written'.padEnd(20)} rows`);
for (const r of m.recordset) {
  const age = r.last_written
    ? Math.round((Date.now() - new Date(r.last_written)) / 86400000) + 'd ago' : '?';
  console.log(`  ${String(r.source).padEnd(12)} ${String(r.newest_period).slice(0, 10).padEnd(14)} ` +
              `${(String(r.last_written).slice(0, 16) + ' (' + age + ')').padEnd(20)} ${r.rows_}`);
}

console.log('\nstandalone tables');
for (const [t, col] of [
  ['gsc_data', 'captured_at'],
  ['se_ranking_position_history', 'captured_at'],
  ['se_ranking_backlink_snapshot', 'captured_at'],
  ['site_pagespeed_snapshot', 'captured_at'],
  ['site_content_item', 'captured_at'],
  ['site_page_link', 'captured_at'],
  ['site_media_item', 'captured_at'],
]) {
  try {
    const r = await pool.request().query(`SELECT n = COUNT(*), newest = MAX(${col}) FROM arion.${t}`);
    const x = r.recordset[0];
    const age = x.newest ? Math.round((Date.now() - new Date(x.newest)) / 86400000) + 'd ago' : 'never';
    console.log(`  ${t.padEnd(32)} ${String(x.n).padStart(8)} rows, newest ${String(x.newest).slice(0, 16)} (${age})`);
  } catch (e) {
    console.log(`  ${t.padEnd(32)} ERROR ${e.message.slice(0, 60)}`);
  }
}

await pool.close();
