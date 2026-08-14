#!/usr/bin/env node
/**
 * _verify_deep_prod.mjs — run the FULL deep-report derivation (the same code
 * the portal renders) over PRODUCTION data, and print the findings.
 *
 * Read-only. The point is to see what a client would actually read today, on
 * one day of history, rather than what the fixtures show with twelve months of
 * it. A report that only reads well on seeded data is not a report.
 *
 * Usage: node scripts/_verify_deep_prod.mjs [domain]
 */
import { getArionMetrics } from '../lib/arionMetrics.js';
import { prodPool } from './_prodsql.mjs';

// The deep engine is TypeScript in the portal. Transpile it with the portal's
// own esbuild and import the OUTPUT, so this runs the real derivation rather
// than a re-implementation that could drift from what clients actually see:
//
//   cd Portal-mybrand
//   ./node_modules/.bin/esbuild src/analytics/deepReport.ts src/analytics/deepConfigs.ts \
//     src/analytics/detail.ts src/analytics/reportNotes.ts src/analytics/scoring.ts \
//     --format=esm --platform=node --outdir=$DEEP_JS_DIR
import { pathToFileURL } from 'node:url';

const DEEP = process.env.DEEP_JS_DIR;
if (!DEEP) { console.error('set DEEP_JS_DIR to the esbuild output directory'); process.exit(1); }
const base = pathToFileURL(DEEP.endsWith('/') ? DEEP : DEEP + '/');
const { deriveDeepReport } = await import(new URL('deepReport.js', base).href);
const { DEEP_CONFIGS } = await import(new URL('deepConfigs.js', base).href);

const ONLY = process.argv[2];
const WATCH = ['content_library', 'page_reachability', 'media_library', 'component_upkeep'];

const pool = await prodPool('iadm_services');
const sites = (await pool.request().query(
  `SELECT site_id, tenant_id, domain FROM arion.site ORDER BY domain`)).recordset
  .filter((s) => !ONLY || s.domain === ONLY);

for (const site of sites) {
  console.log(`\n══ ${site.domain} ══`);
  const out = await getArionMetrics(pool, site, 12);
  for (const id of WATCH) {
    const rep = (out.detail || {})[id];
    if (!rep) continue;
    const deep = deriveDeepReport(rep, DEEP_CONFIGS[id]);
    console.log(`\n  ── ${rep.label}`);
    console.log(`     ${deep.narrative}`);
    for (const m of deep.meaning.slice(0, 2)) console.log(`     · ${m.text.slice(0, 150)}`);
    for (const o of deep.opportunities) console.log(`     [${String(o.total).padStart(3)}] ${o.title}${o.total > o.items.length ? ` (showing ${o.items.length})` : ''}`);
    console.log(`     flags: ${Object.keys(deep.flags).length}`);
  }
}
await pool.close();
