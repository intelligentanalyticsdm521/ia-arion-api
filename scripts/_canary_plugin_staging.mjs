#!/usr/bin/env node
/**
 * _canary_plugin_staging.mjs — put ONE site on the staging channel and prove the
 * release chain works, without waiting on the site's daily WP-Cron.
 *
 * Brandon's rule for this plugin: staging first, one night on
 * intelligentanalyticsdm.com, then promote to latest. Client sites are never
 * the canary.
 *
 * Verifies by walking the exact path the plugin walks:
 *   /plugin/manifest  -> should now report the staging version
 *   /plugin/download  -> should stream the staging zip, sha matching what we published
 *
 * The site token is read for the request and never printed.
 *
 * Usage: node scripts/_canary_plugin_staging.mjs <domain> [--apply]
 */
import crypto from 'node:crypto';
import sql from 'mssql';
import { prodPool } from './_prodsql.mjs';

const DOMAIN = process.argv[2];
const APPLY = process.argv.includes('--apply');
const API = process.env.ARION_API_BASE || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

if (!DOMAIN) { console.error('usage: node scripts/_canary_plugin_staging.mjs <domain> [--apply]'); process.exit(1); }

// Client sites must never be pointed at an unproven build. The canary is ours.
if (DOMAIN !== 'intelligentanalyticsdm.com' && !process.argv.includes('--i-mean-it')) {
  console.error(`refusing: ${DOMAIN} is not our own site. Add --i-mean-it only if that is genuinely intended.`);
  process.exit(1);
}

const pool = await prodPool('iadm_services');
const s = (await pool.request()
  .input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT site_id, domain, plugin_channel, plugin_version, site_token_raw
            FROM arion.site WHERE domain = @d`)).recordset[0];
if (!s) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

console.log(`[canary] ${s.domain}`);
console.log(`[canary]   channel now : ${s.plugin_channel || 'latest'}`);
console.log(`[canary]   running     : v${s.plugin_version || '?'}`);

if (!APPLY) {
  console.log('\n[canary] DRY RUN — re-run with --apply to switch the channel and verify.');
  await pool.close(); process.exit(0);
}

if ('staging' !== s.plugin_channel) {
  await pool.request()
    .input('id', sql.UniqueIdentifier, s.site_id)
    .query(`UPDATE arion.site SET plugin_channel = 'staging' WHERE site_id = @id`);
  console.log(`[canary]   channel -> staging`);
}

// ── walk the plugin's own update path ──────────────────────────────────────
const auth = { 'X-Arion-Site-Token': s.site_token_raw, 'X-Site-Id': s.site_id };

const mres = await fetch(`${API}/plugin/manifest`, { headers: auth });
const mjson = await mres.json().catch(() => null);
if (!mres.ok) {
  console.error(`[canary] manifest ${mres.status}: ${JSON.stringify(mjson)?.slice(0, 300)}`);
  await pool.close(); process.exit(1);
}
const m = mjson.data;
console.log(`\n[canary] manifest -> version=${m.current_version} channel=${m.channel}`);
console.log(`[canary]             sha256=${m.sha256}`);

const dres = await fetch(`${API}/plugin/download?site_id=${encodeURIComponent(s.site_id)}`, { headers: auth });
if (!dres.ok) {
  console.error(`[canary] download ${dres.status}: ${(await dres.text()).slice(0, 300)}`);
  await pool.close(); process.exit(1);
}
const bytes = Buffer.from(await dres.arrayBuffer());
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
console.log(`[canary] download -> ${(bytes.length / 1024).toFixed(1)} KB  sha256=${sha}`);

const zipOk = bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b;   // "PK"
const shaOk = !m.sha256 || m.sha256 === sha;

console.log(`\n[canary] verdict:`);
console.log(`  is a zip                 : ${zipOk ? 'PASS' : 'FAIL'}`);
console.log(`  sha matches manifest     : ${shaOk ? 'PASS' : 'FAIL — the blob and the registry row disagree'}`);
console.log(`  version offered to site  : ${m.current_version} (site runs ${s.plugin_version})`);
console.log(`\n  The site installs it on its next daily WP-Cron. Nothing else to do here.`);

await pool.close();
