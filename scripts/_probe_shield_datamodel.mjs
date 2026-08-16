#!/usr/bin/env node
/**
 * READ-ONLY probe of the live Shield Security (wp-simple-firewall) data model
 * on rollinginitllc.com, so we know exactly what security signals we can read
 * to rewrite the two ARION Security pages off Shield instead of Wordfence.
 * Uses lib/hostingerSsh.js (runWpCli). No writes.
 */
import { runWpCli } from '../lib/hostingerSsh.js';
const DOMAIN = 'rollinginitllc.com';

async function q(label, cmd) {
  try { const r = await runWpCli(DOMAIN, cmd); console.log(`\n### ${label}\n$ wp ${cmd}\n${(r.stdout || '').slice(0, 4000)}`); }
  catch (e) { console.log(`\n### ${label}\n$ wp ${cmd}\n[ERR] ${(e.stderr || e.message || '').slice(0, 600)}`); }
}

console.log('== SHIELD DATA-MODEL PROBE (read-only) — ' + DOMAIN + ' ==');
await q('Shield version', 'plugin get wp-simple-firewall --field=version');
await q('Shield DB tables (icwp/shield/apto)', `db query "SHOW TABLES" --skip-column-names`);
await q('Shield option keys (icwp*)', `option list --search=icwp* --format=csv --fields=option_name`);
await q('Shield option keys (shield*)', `option list --search=shield* --format=csv --fields=option_name`);
await q('Shield option keys (apto*)', `option list --search=apto* --format=csv --fields=option_name`);
await q('Shield wp-cli available?', `shield --help`);
await q('Shield wp-cli (alt)', `help shield`);
await q('Registered REST namespaces (finl/shield?)', `eval "global \\$wp_rest_server; \\$s = rest_get_server(); echo implode(PHP_EOL, array_keys(\\$s->get_namespaces()));"`);
console.log('\n== END PROBE ==');
