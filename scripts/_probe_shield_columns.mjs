#!/usr/bin/env node
/** READ-ONLY: Shield table columns + config keys, so we can write the plugin's
 *  Shield security reader against the real schema. rollinginitllc.com. */
import { runWpCli } from '../lib/hostingerSsh.js';
const DOMAIN = 'rollinginitllc.com';
async function q(label, cmd) {
  try { const r = await runWpCli(DOMAIN, cmd); console.log(`\n### ${label}\n${(r.stdout || '').slice(0, 2500)}`); }
  catch (e) { console.log(`\n### ${label}\n[ERR] ${(e.stderr || e.message || '').slice(0, 400)}`); }
}
const tables = ['scans','scanresults','scanitems','resultitems','resultitem_meta','malware','event','ips','ip_rules','user_meta','at_logs','req_logs','botsignal'];
console.log('== SHIELD COLUMN PROBE ==');
for (const t of tables) {
  await q(`columns ${t}`, `db query "SHOW COLUMNS FROM wp_icwp_wpsf_${t}" --skip-column-names`);
  await q(`rowcount ${t}`, `db query "SELECT COUNT(*) FROM wp_icwp_wpsf_${t}" --skip-column-names`);
}
await q('opts_all top-level module keys', `eval "\\$o=get_option('icwp_wpsf_opts_all'); echo is_array(\\$o)?implode(',',array_keys(\\$o)):gettype(\\$o).PHP_EOL;"`);
await q('event: distinct event keys (top 20)', `db query "SELECT event, COUNT(*) c FROM wp_icwp_wpsf_event GROUP BY event ORDER BY c DESC LIMIT 20" --skip-column-names`);
await q('scans: recent', `db query "SELECT scan, started_at, finished_at FROM wp_icwp_wpsf_scans ORDER BY id DESC LIMIT 5" --skip-column-names`);
console.log('\n== END ==');
