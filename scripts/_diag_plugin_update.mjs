#!/usr/bin/env node
/**
 * _diag_plugin_update.mjs — why did this site not take the update?
 *
 * Walks the same four steps the plugin's updater walks, from the site's own
 * point of view, and says which one failed. Beats guessing, and beats
 * hand-copying the file over SFTP — which "fixes" the symptom while leaving the
 * updater just as broken for the next release.
 *
 * Read-only. Usage: node scripts/_diag_plugin_update.mjs <domain>
 */
import sql from 'mssql';
import { runWpCli } from '../lib/hostingerSsh.js';
import { prodPool } from './_prodsql.mjs';

const DOMAIN = process.argv[2];
if (!DOMAIN) { console.error('usage: node scripts/_diag_plugin_update.mjs <domain>'); process.exit(1); }

const pool = await prodPool('iadm_services');
const s = (await pool.request().input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT site_id, domain, plugin_channel, plugin_version, site_token_raw
            FROM arion.site WHERE domain = @d`)).recordset[0];
if (!s) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

// wp-cli exits 1 for an option that simply is not set, which is a normal state
// here, not a failure — swallow only that and let real errors surface.
const wp = async (a) => {
  try { return ((await runWpCli(DOMAIN, a)).stdout || '').trim(); }
  catch (e) {
    if (/Could not get .* option/i.test(e.stderr || e.message || '')) return '';
    return `ERROR: ${(e.stderr || e.message || '').trim().slice(0, 160)}`;
  }
};
console.log(`\n${s.domain}`);

// 1. what the site has, and where it thinks our API is
const installed = await wp(`plugin get intelligent-analytics --field=version`);
const apiBase = await wp(`option get ia_api_base`) || '(default prod)';
const siteIdOpt = await wp(`option get ia_site_id`);
const tokenOpt = await wp(`option get ia_site_token`);
console.log(`  installed        : v${installed}`);
console.log(`  ia_api_base      : ${apiBase}`);
console.log(`  ia_site_id       : ${siteIdOpt || '(missing)'}  ${siteIdOpt === s.site_id ? 'matches registry' : 'DOES NOT MATCH REGISTRY'}`);
console.log(`  ia_site_token    : ${tokenOpt ? 'set (' + tokenOpt.length + ' chars)' : '(missing)'}`);

// 2. is the update cron even scheduled?
const cron = await wp(`cron event list --fields=hook,next_run_relative --format=csv --hook=ia_check_plugin_update`);
const hooked = cron.split('\n').find((l) => l.startsWith('ia_check_plugin_update'));
console.log(`  update cron      : ${hooked || 'NOT SCHEDULED'}`);

// 3. can the SITE reach the manifest? Ask the site to make the call itself —
//    the network path that matters is the site's, not this machine's.
const probe = await wp(
  `eval "` +
  `\\$b = get_option('ia_api_base') ?: 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';` +
  `\\$r = wp_remote_get(trailingslashit(\\$b).'plugin/manifest', ['timeout'=>20,'headers'=>[` +
  `'X-Arion-Site-Token'=>get_option('ia_site_token'),'X-Site-Id'=>get_option('ia_site_id')]]);` +
  `if (is_wp_error(\\$r)) { echo 'WP_ERROR: '.\\$r->get_error_message(); }` +
  `else { echo wp_remote_retrieve_response_code(\\$r).' '.substr(wp_remote_retrieve_body(\\$r),0,220); }"`);
console.log(`  manifest (from the site): ${probe.slice(0, 260)}`);

// 4. can it write to its own plugin directory?
const writable = await wp(
  `eval "echo (is_writable(WP_PLUGIN_DIR.'/intelligent-analytics') ? 'yes' : 'NO') . ' | ' . ` +
  `(is_writable(WP_PLUGIN_DIR.'/intelligent-analytics/intelligent-analytics.php') ? 'yes' : 'NO');"`);
console.log(`  plugin dir / file writable: ${writable}`);

const fsMethod = await wp(`eval "require_once ABSPATH.'wp-admin/includes/file.php'; echo get_filesystem_method();"`);
console.log(`  filesystem method: ${fsMethod}  ${fsMethod === 'direct' ? '' : '<-- non-direct blocks Plugin_Upgrader without credentials'}`);

await pool.close();
