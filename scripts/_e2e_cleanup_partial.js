// Clean up partial state from a failed e2e seed.
// Targets the tenant slug pattern and email pattern used by _e2e_v2_run.js.
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

async function getPool(database) {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });
  await pool.connect();
  return pool;
}

async function main() {
  const platformPool = await getPool('iadm_platform');
  const servicesPool = await getPool('iadm_services');

  // Find tenants by slug pattern
  const r1 = await platformPool.request().query(`
    SELECT tenant_id, name, slug FROM core.tenants WHERE slug LIKE 'arion-test-v2-%'
  `);
  console.log('Tenants to clean (' + r1.recordset.length + '):');
  for (const t of r1.recordset) console.log('  ' + t.slug + ' ' + t.tenant_id);

  for (const t of r1.recordset) {
    // delete tenant_services / tenant_users / arion.site / signup_session / users (only ones tied to this tenant)
    await servicesPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('DELETE FROM arion.signup_session WHERE tenant_id = @tid');
    await servicesPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('DELETE FROM arion.site WHERE tenant_id = @tid');
    await platformPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('DELETE FROM core.tenant_services WHERE tenant_id = @tid');
    // capture user ids before unlinking
    const ulink = await platformPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('SELECT user_id FROM core.tenant_users WHERE tenant_id = @tid');
    await platformPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('DELETE FROM core.tenant_users WHERE tenant_id = @tid');
    for (const u of ulink.recordset) {
      // only delete if this user isn't linked to any OTHER tenant
      const other = await platformPool.request()
        .input('uid', sql.UniqueIdentifier, u.user_id)
        .query('SELECT TOP 1 1 AS h FROM core.tenant_users WHERE user_id = @uid');
      if (other.recordset.length === 0) {
        await platformPool.request()
          .input('uid', sql.UniqueIdentifier, u.user_id)
          .query('DELETE FROM core.users WHERE user_id = @uid');
      }
    }
    await platformPool.request()
      .input('tid', sql.UniqueIdentifier, t.tenant_id)
      .query('DELETE FROM core.tenants WHERE tenant_id = @tid');
    console.log('  Deleted ' + t.slug);
  }

  await platformPool.close();
  await servicesPool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
