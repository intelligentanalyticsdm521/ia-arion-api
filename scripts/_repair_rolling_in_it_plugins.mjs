#!/usr/bin/env node
/**
 * One-off repair: re-run installPluginsForTier for Rolling In It with the
 * full Pro-tier Golden Master subset (intelligent-analytics + Elementor +
 * Elementor Pro + Wordfence + EWWW + RankMath + LiteSpeed + safe-svg +
 * wp-mail-smtp + ACF). Mints a fresh 7-day provision code first so the paid
 * blob endpoint /plugin/paid/elementor-pro?token=... is authorized.
 *
 * Why this exists: routes/admin/onboard-existing.js used to skip the plugin
 * pipeline entirely, leaving Rolling In It missing Elementor Pro + Wordfence
 * + IA EWWW config. The handler is now fixed (2026-06-24), but RII was
 * already onboarded against the broken handler so it needs a backfill run.
 *
 * Usage:
 *   cd C:/dev/iadm/arion-api
 *   node scripts/_repair_rolling_in_it_plugins.mjs
 *
 * After it finishes, re-run scripts/_probe_rii_plugins.mjs to verify:
 *   - elementor-pro INSTALLED
 *   - wordfence INSTALLED
 *   - elementor_pro_license_key non-empty (first 4 chars match KV elementor-pro)
 *   - ewww_image_optimizer_webp = 1, lazy_load = 0, jpg_quality = 82
 */

import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { installPluginsForTier } from '../lib/pluginStack.js';
import { createProvisionCode } from '../lib/provisionCodes.js';

const TENANT_ID = '12839687-67FA-4144-A152-1219D1A64901';
const SITE_ID   = '4E3B2AE2-4133-4813-84AA-4196661ED6F9';
const DOMAIN    = 'rollinginitllc.com';
const TIER      = 'pro';

const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

async function getServicesPool() {
  const cred = new DefaultAzureCredential();
  const tok = await cred.getToken('https://database.windows.net/.default');
  return await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } },
  });
}

async function main() {
  console.log(`[repair-rii] start tenant=${TENANT_ID} site=${SITE_ID} domain=${DOMAIN} tier=${TIER}`);

  const pool = await getServicesPool();

  // Mint a fresh 7-day provision code so /plugin/paid/:slug auth still works.
  const codeRes = await createProvisionCode(pool, {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    createdBy: 'repair_rolling_in_it_plugins',
    ttlDays: 7,
  });
  const provisionCode = codeRes.code;
  const pluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(provisionCode)}`;
  console.log(`[repair-rii] minted provision code ${provisionCode.slice(0, 8)}… (7-day TTL)`);
  console.log(`[repair-rii] iaPluginDownloadUrl=${pluginDownloadUrl}`);

  // Run the install pipeline with the IA-owned subset. Same list the
  // /admin/onboard-existing handler now uses.
  let result;
  try {
    result = await installPluginsForTier({
      domain: DOMAIN,
      tier: TIER,
      installShop: false,
      publishPdfs: false,
      iaPluginDownloadUrl: pluginDownloadUrl,
      provisionCode,
      onlySlugs: [
        'intelligent-analytics',
        'hello-elementor',
        'elementor',
        'elementor-pro',
        'wordfence',
        'ewww-image-optimizer',
        'seo-by-rank-math',
        'litespeed-cache',
        'wp-mail-smtp',
        'safe-svg',
        'advanced-custom-fields',
      ],
    });
  } catch (err) {
    console.error(`[repair-rii] installPluginsForTier threw: ${err.message}`);
    if (err.code === 'NO_WP_INSTALL') {
      console.error('[repair-rii] WP install directory missing on box — verify SSH cred + domain spelling');
    }
    process.exit(2);
  }

  console.log('\n[repair-rii] ─── install summary ──────────────────────────────');
  console.log(`  installed: ${JSON.stringify(result.installed)}`);
  console.log(`  skipped:   ${JSON.stringify(result.skipped)}`);
  console.log(`  failed:    ${JSON.stringify(result.failed, null, 2)}`);
  console.log('\n[repair-rii] ─── logs (last 30) ────────────────────────────────');
  for (const entry of result.logs.slice(-30)) {
    console.log(`  ${JSON.stringify(entry)}`);
  }

  // Persist outcomes onto arion.site so the dashboard reflects the repair.
  try {
    const existing = await pool.request()
      .input('sid', sql.UniqueIdentifier, SITE_ID)
      .query('SELECT provisioning_details_json FROM arion.site WHERE site_id = @sid');
    let details = {};
    const raw = existing.recordset[0]?.provisioning_details_json;
    if (raw) {
      try { details = JSON.parse(raw) || {}; } catch (_) { details = {}; }
    }
    details.plugin_install_status = result.failed.length > 0 ? 'ssh_partial' : 'ssh_success';
    details.plugin_install_error = result.failed.length > 0 ? JSON.stringify(result.failed).slice(0, 300) : null;
    details.plugins_installed = result.installed;
    details.plugins_failed = result.failed;
    details.plugins_skipped = result.skipped;
    details.last_repair_at = new Date().toISOString();
    details.last_repair_source = 'scripts/_repair_rolling_in_it_plugins.mjs';
    await pool.request()
      .input('sid', sql.UniqueIdentifier, SITE_ID)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query('UPDATE arion.site SET provisioning_details_json = @details, updated_at = SYSDATETIMEOFFSET() WHERE site_id = @sid');
    console.log('\n[repair-rii] persisted outcomes to arion.site.provisioning_details_json');
  } catch (persistErr) {
    console.warn(`[repair-rii] persist failed (non-fatal): ${persistErr.message}`);
  }

  if (result.failed.length > 0) {
    console.log('\n[repair-rii] FINISHED WITH FAILURES — see failed[] above. Re-run scripts/_probe_rii_plugins.mjs to verify state.');
    process.exit(1);
  }
  console.log('\n[repair-rii] DONE — all plugins installed cleanly. Re-run scripts/_probe_rii_plugins.mjs to confirm state.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
