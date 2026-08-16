#!/usr/bin/env node
/**
 * Drop the stale wp_wf* Wordfence tables on the 3 client sites. Wordfence's
 * PLUGIN was deleted but WordPress leaves plugin tables behind; nothing reads
 * them now (the IA plugin reads Shield's wp_icwp_wpsf_* tables). This removes
 * the last Wordfence remnant. Shield tables (icwp_wpsf_*) are NOT matched by
 * the `<prefix>wf%` pattern, so they're untouched.
 */
import { runWpCli } from '../lib/hostingerSsh.js';
const SITES = [ 'rollinginitllc.com', 'briarwoodsmiles.com', 'midwestagservices.com' ];

for (const domain of SITES) {
  try {
    console.log(`\n── ${domain}`);
    const prefix = ((await runWpCli(domain, 'config get table_prefix')).stdout || 'wp_').trim();
    const list = ((await runWpCli(domain, `db query "SHOW TABLES LIKE '${prefix}wf%'" --skip-column-names`)).stdout || '').trim();
    const tables = list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!tables.length) { console.log('  no wp_wf* tables — already clean'); continue; }
    console.log(`  found ${tables.length}: ${tables.join(', ')}`);
    await runWpCli(domain, `db query "DROP TABLE IF EXISTS ${tables.join(', ')}"`);
    const after = ((await runWpCli(domain, `db query "SHOW TABLES LIKE '${prefix}wf%'" --skip-column-names`)).stdout || '').trim();
    console.log(after ? `  REMAINING: ${after}` : `  ✓ dropped ${tables.length} tables, none remain`);
  } catch (e) {
    console.log(`  ERR ${(e.stderr || e.message || '').slice(0, 300)}`);
  }
}
console.log('\n== done ==');
