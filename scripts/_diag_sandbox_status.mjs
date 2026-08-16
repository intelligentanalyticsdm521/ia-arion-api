// READ-ONLY: did the IA plugin connect, and what is on the box now?
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { assertProd } from './_diag_prod_guard.mjs';
import { runWpCli } from '../lib/hostingerSsh.js';

const SITE_ID = 'F3795ADE-A799-F111-9B33-002248452390';
const DOMAIN = 'azure-coyote-795824.hostingersite.com';

const pool = await getServicesPool();
await assertProd(pool);

const r = await pool.request()
  .input('sid', sql.UniqueIdentifier, SITE_ID)
  .query(`SELECT domain, status, arion_tier, seo_addon_tier, plugin_status, plugin_version,
                 plugin_connected_at, plugin_last_status_at,
                 CASE WHEN site_token_hash IS NULL THEN 'no' ELSE 'yes' END AS has_site_token
            FROM arion.site WHERE site_id=@sid`);
console.log('=== arion.site (prod) ===');
console.log(JSON.stringify(r.recordset[0], null, 2));

const codes = await pool.request()
  .input('sid', sql.UniqueIdentifier, SITE_ID)
  .query(`SELECT created_at, redeemed_at, redeemed_from_url FROM arion.site_provision_code
           WHERE site_id=@sid ORDER BY created_at DESC`);
console.log('\n=== provision codes ===');
for (const c of codes.recordset) console.log('  ', JSON.stringify(c));

console.log('\n=== plugins on the box ===');
try {
  const out = await runWpCli(DOMAIN, 'plugin list --format=csv --fields=name,status,version');
  console.log((out.stdout || out || '').toString().trim());
} catch (e) { console.log('wp plugin list failed:', e.message); }

console.log('\n=== wp_mail_smtp option (password redacted) ===');
try {
  const out = await runWpCli(DOMAIN, 'option get wp_mail_smtp --format=json');
  const raw = (out.stdout || out || '').toString().trim();
  const parsed = JSON.parse(raw);
  if (parsed?.smtp?.pass) parsed.smtp.pass = '<redacted>';
  console.log(JSON.stringify(parsed, null, 2));
} catch (e) { console.log('not set / unreadable:', (e.stderr || e.message || '').toString().slice(0, 200)); }

process.exit(0);
