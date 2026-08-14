#!/usr/bin/env node
/**
 * _force_plugin_update_check.mjs — make a site run its plugin self-update NOW
 * instead of waiting for the daily WP-Cron.
 *
 * This deliberately does NOT copy the plugin file over SFTP. Hand-copying is
 * what produced the 1.3.0-published / 1.3.3-running split in the first place:
 * the site moves and the registry does not, and then a newly onboarded site
 * installs the stale build forever. Firing `ia_check_plugin_update` runs the
 * plugin's own updater — manifest, download, Plugin_Upgrader — which is the
 * exact path it would take tonight. Forcing the real path also TESTS the real
 * path; copying a file tests nothing.
 *
 * Refuses any site but ours unless told explicitly: an unproven build has no
 * business on a client site.
 *
 * Usage: node scripts/_force_plugin_update_check.mjs <domain> [--apply]
 */
import sql from 'mssql';
import { runWpCli } from '../lib/hostingerSsh.js';
import { prodPool } from './_prodsql.mjs';

const DOMAIN = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!DOMAIN) { console.error('usage: node scripts/_force_plugin_update_check.mjs <domain> [--apply]'); process.exit(1); }
if (DOMAIN !== 'intelligentanalyticsdm.com' && !process.argv.includes('--i-mean-it')) {
  console.error(`refusing: ${DOMAIN} is not our own site. Add --i-mean-it only if that is genuinely intended.`);
  process.exit(1);
}

const pool = await prodPool('iadm_services');
const before = (await pool.request()
  .input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT domain, plugin_version, plugin_channel FROM arion.site WHERE domain = @d`)).recordset[0];
if (!before) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

console.log(`${before.domain}`);
console.log(`  registry says : v${before.plugin_version} on channel ${before.plugin_channel}`);

const installed = async () => ((await runWpCli(DOMAIN,
  `plugin get intelligent-analytics --field=version`)).stdout || '').trim();

const v0 = await installed();
console.log(`  site has      : v${v0}`);

if (!APPLY) {
  console.log('\nDRY RUN — re-run with --apply to fire ia_check_plugin_update.');
  await pool.close(); process.exit(0);
}

// The hook is registered by the plugin, so a bare `cron event run` is enough —
// no need to schedule anything or touch the plugin's files.
console.log('\n  firing ia_check_plugin_update ...');
const run = await runWpCli(DOMAIN, `cron event run ia_check_plugin_update`);
console.log(`  ${((run.stdout || '') + (run.stderr || '')).trim().slice(0, 400)}`);

const v1 = await installed();
console.log(`\n  site now has  : v${v1}`);
console.log(`  verdict       : ${v1 !== v0 ? `UPDATED ${v0} -> ${v1}` : `unchanged (still ${v1})`}`);

if (v1 !== v0) {
  await pool.request()
    .input('d', sql.NVarChar(255), DOMAIN)
    .input('v', sql.NVarChar(20), v1)
    .query(`UPDATE arion.site SET plugin_version = @v, plugin_last_status_at = SYSDATETIMEOFFSET() WHERE domain = @d`);
  console.log(`  registry updated to v${v1}`);
}

await pool.close();
