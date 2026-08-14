#!/usr/bin/env node
/**
 * _repair_site_id_option.mjs — restore the `ia_site_id` option a site needs to
 * update itself.
 *
 * THE DEFECT: the plugin's updater sends `X-Site-Id: get_option('ia_site_id')`
 * with its manifest call. On briarwoodsmiles.com and midwestagservices.com that
 * option is missing entirely, so every manifest call has returned
 * 400 MISSING_CONTEXT and those sites have NEVER been able to update
 * themselves — which is why they were hand-deployed over SSH, which in turn is
 * why arion.plugin_version drifted behind what they were running.
 *
 * Nothing surfaced it. The cron fired daily, failed silently, and the site
 * looked healthy: connected, reporting, answering every call we made TO it.
 * The break was only in the direction the site calls US.
 *
 * The fix is one option, taken from the registry — not an SFTP copy of the
 * plugin file. Copying the file makes this release work and leaves the next one
 * just as broken.
 *
 * Usage: node scripts/_repair_site_id_option.mjs <domain|--all> [--apply]
 */
import sql from 'mssql';
import { runWpCli } from '../lib/hostingerSsh.js';
import { prodPool } from './_prodsql.mjs';

const ARG = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!ARG) { console.error('usage: node scripts/_repair_site_id_option.mjs <domain|--all> [--apply]'); process.exit(1); }

const pool = await prodPool('iadm_services');
const sites = (await pool.request().query(
  `SELECT site_id, domain, plugin_version FROM arion.site
    WHERE plugin_status = 'connected' ORDER BY domain`)).recordset
  .filter((s) => ARG === '--all' || s.domain === ARG);

if (!sites.length) { console.error(`no connected site matching ${ARG}`); process.exit(1); }
console.log(`mode=${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

let repaired = 0, already = 0;
for (const s of sites) {
  const wp = async (a) => {
    try { return ((await runWpCli(s.domain, a)).stdout || '').trim(); }
    catch (e) { if (/Could not get .* option/i.test(e.stderr || '')) return ''; throw e; }
  };

  const current = await wp(`option get ia_site_id`);
  if (current && current.toUpperCase() === String(s.site_id).toUpperCase()) {
    console.log(`  ${s.domain.padEnd(30)} already correct`);
    already++;
    continue;
  }

  console.log(`  ${s.domain.padEnd(30)} ${current ? `WRONG (${current})` : 'MISSING'} -> ${s.site_id}`);
  if (!APPLY) continue;

  await runWpCli(s.domain, `option update ia_site_id ${s.site_id}`);

  // Verify the repair by making the SITE call the manifest itself. Writing the
  // option and declaring victory is how this stayed broken in the first place.
  const probe = await wp(
    `eval "` +
    `\\$b = get_option('ia_api_base') ?: 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';` +
    `\\$r = wp_remote_get(trailingslashit(\\$b).'plugin/manifest', ['timeout'=>20,'headers'=>[` +
    `'X-Arion-Site-Token'=>get_option('ia_site_token'),'X-Site-Id'=>get_option('ia_site_id')]]);` +
    `echo is_wp_error(\\$r) ? 'WP_ERROR '.\\$r->get_error_message() : wp_remote_retrieve_response_code(\\$r);"`);
  const ok = probe.trim() === '200';
  console.log(`  ${''.padEnd(30)} manifest now: ${probe.trim()}  ${ok ? 'FIXED' : 'STILL FAILING'}`);
  if (ok) repaired++;
}

console.log(`\n  ${already} already correct, ${repaired} repaired`);
if (!APPLY) console.log('  DRY RUN — re-run with --apply.');
await pool.close();
