// Cold Start sandbox site setup.
//   node scripts/_diag_sandbox_setup.mjs            -> read-only: conventions + current state
//   node scripts/_diag_sandbox_setup.mjs --create   -> create the arion.site row (idempotent)
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { assertProd } from './_diag_prod_guard.mjs';

const TENANT = '71662CBC-B28F-4A4C-860B-497285BFA468';
const DOMAIN = 'azure-coyote-795824.hostingersite.com';
const DO_CREATE = process.argv.includes('--create');

const pool = await getServicesPool();
await assertProd(pool);

// 1. What do real rows look like? Match conventions instead of inventing values.
const conv = await pool.request().query(`
  SELECT TOP 8 domain, status, tier, arion_tier, seo_addon_tier, hosting_plan,
         domain_mode, provisioning_state, plugin_status, plugin_channel
    FROM arion.site ORDER BY created_at DESC`);
console.log('=== existing arion.site rows (conventions) ===');
for (const r of conv.recordset) console.log('  ', JSON.stringify(r));

const distinct = await pool.request().query(`
  SELECT 'status' k, status v, COUNT(*) n FROM arion.site GROUP BY status
  UNION ALL SELECT 'tier', tier, COUNT(*) FROM arion.site GROUP BY tier
  UNION ALL SELECT 'domain_mode', domain_mode, COUNT(*) FROM arion.site GROUP BY domain_mode
  UNION ALL SELECT 'provisioning_state', provisioning_state, COUNT(*) FROM arion.site GROUP BY provisioning_state
  UNION ALL SELECT 'seo_addon_tier', seo_addon_tier, COUNT(*) FROM arion.site GROUP BY seo_addon_tier`);
console.log('\n=== distinct values in use ===');
for (const r of distinct.recordset) console.log(`  ${r.k.padEnd(20)} ${String(r.v ?? 'NULL').padEnd(22)} x${r.n}`);

// 2. Current state for this tenant / domain.
const cur = await pool.request()
  .input('tid', sql.UniqueIdentifier, TENANT)
  .input('dom', sql.NVarChar, DOMAIN)
  .query(`SELECT site_id, tenant_id, domain, status, tier, arion_tier, seo_addon_tier, plugin_status
            FROM arion.site WHERE tenant_id=@tid OR domain=@dom`);
console.log(`\n=== Cold Start / sandbox rows: ${cur.recordset.length} ===`);
for (const r of cur.recordset) console.log('  ', JSON.stringify(r));

if (!DO_CREATE) { console.log('\n(read-only — pass --create to insert)'); process.exit(0); }
if (cur.recordset.length > 0) { console.log('\nrow already exists — nothing to do'); process.exit(0); }

const ins = await pool.request()
  .input('tid', sql.UniqueIdentifier, TENANT)
  .input('dom', sql.NVarChar, DOMAIN)
  .query(`
    INSERT INTO arion.site
      (tenant_id, domain, status, tier, arion_tier, seo_addon_tier, hosting_plan,
       wp_admin_url, domain_mode, provisioning_state, plugin_channel, provisioned_at)
    OUTPUT INSERTED.site_id
    VALUES
      (@tid, @dom, 'active', 'business', 'business', 'authority', 'business',
       'https://' + @dom + '/wp-admin', NULL, NULL, 'latest', SYSUTCDATETIME())`);

console.log(`\nCREATED site_id = ${ins.recordset[0].site_id}`);
process.exit(0);
