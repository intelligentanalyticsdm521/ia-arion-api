// Install IA plugin stack on the Cold Start sandbox.
//   node scripts/_diag_sandbox_install.mjs                        -> IA plugin only
//   node scripts/_diag_sandbox_install.mjs wp-mail-smtp           -> just re-apply SMTP
//   node scripts/_diag_sandbox_install.mjs a,b,c                  -> explicit slugs
// MUST be run with prod env (the guard enforces it):
//   SERVICES_SQL_SERVER=sql-iadm-prod-cus.database.windows.net SQL_USER= SQL_PASSWORD=
//
// DELIBERATELY NEVER INSTALLED HERE (this sandbox is Brandon's live Elementor
// template workspace — each of these would damage it):
//   hello-elementor  - `theme install --activate --force` swaps the active theme
//   elementor-pro    - blob install --force overwrites the working 4.2.1 + relicenses
//   elementor        - already active at 4.2.2
//   litespeed-cache  - already active at 7.9 and configured
import { getServicesPool } from '../db/servicesPool.js';
import { createProvisionCode } from '../lib/provisionCodes.js';
import { installPluginsForTier } from '../lib/pluginStack.js';
import { assertProd } from './_diag_prod_guard.mjs';

const TENANT = '71662CBC-B28F-4A4C-860B-497285BFA468';
const SITE_ID = 'F3795ADE-A799-F111-9B33-002248452390';  // prod row, created 2026-08-16
const DOMAIN = 'azure-coyote-795824.hostingersite.com';
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

const ONLY = (process.argv[2] || 'intelligent-analytics').split(',').map((s) => s.trim()).filter(Boolean);

const pool = await getServicesPool();
await assertProd(pool);

const code = await createProvisionCode(pool, {
  tenantId: TENANT, siteId: SITE_ID, createdBy: 'sandbox:coldstart', ttlDays: 1,
});
const iaPluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(code.code)}`;

// Pre-flight the download from HERE before wp-cli tries it from the WP box, so
// a 403/404 surfaces as a clean message instead of "plugin could not be found".
const probe = await fetch(iaPluginDownloadUrl, { method: 'GET', redirect: 'follow' })
  .then((r) => ({ status: r.status, type: r.headers.get('content-type') }))
  .catch((e) => ({ status: 'ERR', err: e.message }));
console.log('plugin download probe:', JSON.stringify(probe));
if (probe.status !== 200) {
  console.error('ABORT: arion-api will not serve the plugin zip for this code.');
  process.exit(1);
}

console.log(`\ninstalling [${ONLY.join(', ')}] on ${DOMAIN} ...\n`);
const res = await installPluginsForTier({
  domain: DOMAIN, tier: 'business', installShop: false, publishPdfs: false,
  iaPluginDownloadUrl, provisionCode: code.code, onlySlugs: ONLY,
});

console.log('\n================ RESULT ================');
console.log('installed:', JSON.stringify(res.installed));
console.log('skipped  :', JSON.stringify(res.skipped));
console.log('failed   :', JSON.stringify(res.failed, null, 2));
process.exit(0);
