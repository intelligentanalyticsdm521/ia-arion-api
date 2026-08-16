// Connect the sandbox: redeem a provision code and write the plugin options.
//
// This is byte-for-byte what the plugin's Settings -> Quick Connect does
// (POST /public/provision-codes/redeem, then update_option on the 6 ia_* keys).
// Doing it over wp-cli avoids needing a WP admin login. No password is involved
// anywhere in this flow — the one-time provision code IS the credential.
//
//   SERVICES_SQL_SERVER=sql-iadm-prod-cus.database.windows.net SQL_USER= SQL_PASSWORD= \
//     node scripts/_diag_sandbox_connect.mjs
import { getServicesPool } from '../db/servicesPool.js';
import { createProvisionCode } from '../lib/provisionCodes.js';
import { runWpCli } from '../lib/hostingerSsh.js';
import { assertProd } from './_diag_prod_guard.mjs';

const TENANT = '71662CBC-B28F-4A4C-860B-497285BFA468';
const SITE_ID = 'F3795ADE-A799-F111-9B33-002248452390';
const DOMAIN = 'azure-coyote-795824.hostingersite.com';
const SITE_URL = `https://${DOMAIN}`;
const API = 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

const pool = await getServicesPool();
await assertProd(pool);

// Fresh single-use code (earlier ones may have been consumed by a retry).
const { code } = await createProvisionCode(pool, {
  tenantId: TENANT, siteId: SITE_ID, createdBy: 'sandbox:connect', ttlDays: 1,
});

const r = await fetch(`${API}/public/provision-codes/redeem`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, site_url: SITE_URL, admin_email: 'brandonsheriff+coldstart@gmail.com' }),
});
const body = await r.json().catch(() => null);
console.log(`redeem -> HTTP ${r.status}`);
const d = body?.data;
if (!d?.site_token) {
  console.error('redeem failed:', JSON.stringify(body));
  process.exit(1);
}
console.log(`  site_id=${d.site_id} tenant_id=${d.tenant_id} tier=${d.tier ?? '-'} seo_addon=${d.seo_addon ?? '-'} site_token=<received, ${String(d.site_token).length} chars>`);

const opts = [
  ['ia_arion_api_url', API],
  ['ia_site_id', d.site_id || ''],
  ['ia_tenant_id', d.tenant_id || ''],
  ['ia_site_token', d.site_token],
  ['ia_tier', d.tier || 'business'],
  ['ia_seo_addon', d.seo_addon || 'authority'],
];
for (const [k, v] of opts) {
  try {
    await runWpCli(DOMAIN, `option update ${k} '${String(v).replace(/'/g, `'\\''`)}'`);
    console.log(`  set ${k} = ${k === 'ia_site_token' ? '<redacted>' : v}`);
  } catch (e) {
    console.error(`  FAILED ${k}: ${(e.stderr || e.message || '').toString().slice(0, 200)}`);
  }
}
process.exit(0);
