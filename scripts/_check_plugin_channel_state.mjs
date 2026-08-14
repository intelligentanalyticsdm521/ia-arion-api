#!/usr/bin/env node
/**
 * _check_plugin_channel_state.mjs — read-only.
 *
 * The self-update path is: WP-Cron -> /plugin/manifest -> compare -> download.
 * That whole chain is driven by arion.plugin_version.is_current. If the
 * published row is BEHIND what the sites already run, every new site installs
 * a stale build and never catches up, because manifest never reports anything
 * newer than what is installed.
 *
 * Prints the published rows per channel next to what each site is actually
 * running, so the gap is visible in one screen.
 *
 * Usage: node scripts/_check_plugin_channel_state.mjs   (prod, Entra token)
 */
import { prodPool } from './_prodsql.mjs';

const pool = await prodPool('iadm_services');

console.log(`\n=== arion.plugin_version (published) ===`);
const pv = await pool.request().query(`
  SELECT channel, version, is_current, released_at, blob_path,
         sha = CASE WHEN sha256 IS NULL THEN 'no' ELSE 'yes' END
    FROM arion.plugin_version
   ORDER BY channel, released_at DESC`);
if (!pv.recordset.length) console.log('  (no rows)');
for (const r of pv.recordset) {
  console.log(
    `  ${String(r.channel).padEnd(9)} ${String(r.version).padEnd(9)}` +
    ` current=${r.is_current ? 'YES' : ' no'}  ${new Date(r.released_at).toISOString().slice(0, 10)}  ${r.blob_path}`
  );
}

console.log(`\n=== arion.site (running) ===`);
const st = await pool.request().query(`
  SELECT domain, plugin_status, plugin_version, plugin_channel, plugin_last_status_at
    FROM arion.site
   ORDER BY domain`);
for (const r of st.recordset) {
  const seen = r.plugin_last_status_at
    ? new Date(r.plugin_last_status_at).toISOString().slice(0, 16).replace('T', ' ')
    : 'never';
  console.log(
    `  ${String(r.domain).padEnd(34)} ${String(r.plugin_status || '-').padEnd(11)}` +
    ` v${String(r.plugin_version || '?').padEnd(8)} ch=${String(r.plugin_channel || 'latest').padEnd(8)} seen ${seen}`
  );
}

// The actual verdict, so nobody has to eyeball two tables.
const cur = Object.fromEntries(
  pv.recordset.filter((r) => r.is_current).map((r) => [r.channel, r.version])
);
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};
console.log(`\n=== verdict ===`);
let bad = 0;
for (const r of st.recordset) {
  const ch = r.plugin_channel || 'latest';
  const published = cur[ch];
  if (!published) { console.log(`  ${r.domain}: channel "${ch}" has NO current published version`); bad++; continue; }
  if (!r.plugin_version) continue;
  const d = cmp(r.plugin_version, published);
  if (d > 0) { console.log(`  ${r.domain}: running v${r.plugin_version} but "${ch}" publishes v${published} — PUBLISHED ROW IS STALE`); bad++; }
  else if (d < 0) console.log(`  ${r.domain}: running v${r.plugin_version}, update to v${published} pending`);
}
if (!bad) console.log('  channels look sane');

await pool.close();
