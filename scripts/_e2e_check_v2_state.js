// Probe the deployed arion-api for V2 readiness:
//   - Is the new code (commit 1799681) live?
//   - Does the env have the keys/secrets/order-id we need to actually run?
//   - Are there ANY existing arion sites we could reuse for a non-destructive
//     verify (re-publishing an Elementor page to an existing WP install)?
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const API_BASE = 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

async function main() {
  // 1. Probe /health and look for any V2-specific route
  for (const path of ['/health', '/onboarding/status?session_id=__probe__', '/arion/website-builder/health', '/blocks']) {
    try {
      const r = await fetch(API_BASE + path, { method: 'GET' });
      console.log(`GET ${path} -> HTTP ${r.status}`);
    } catch (e) {
      console.log(`GET ${path} -> ERR ${e.message}`);
    }
  }
  // 2. DB checks
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const services = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });
  const r1 = await services.request().query(`
    SELECT COUNT(*) AS sites FROM arion.site WHERE provisioning_state='ready'
  `);
  console.log('\nready arion.site rows:', r1.recordset[0].sites);

  const r2 = await services.request().query(`
    SELECT TOP 5 site_id, domain, tenant_id, provisioning_state,
                  JSON_VALUE(provisioning_details_json,'$.builder_version') AS builder_version,
                  JSON_VALUE(provisioning_details_json,'$.elementor_globals_set') AS elementor_globals_set,
                  JSON_VALUE(provisioning_details_json,'$.pages_built') AS pages_built,
                  created_at
    FROM arion.site
    ORDER BY created_at DESC
  `);
  console.log('\nMost recent sites:');
  for (const row of r2.recordset) {
    console.log(`  ${row.domain}  state=${row.provisioning_state}  v=${row.builder_version || '-'}  globals=${row.elementor_globals_set || '-'}  pages=${row.pages_built || '-'}  created=${row.created_at?.toISOString?.() || row.created_at}`);
  }

  // 3. Check signup_session rows
  const r3 = await services.request().query(`
    SELECT TOP 5 session_pk, tenant_id, site_id, email, status, created_at
    FROM arion.signup_session
    ORDER BY created_at DESC
  `);
  console.log('\nMost recent signup_session rows:');
  for (const row of r3.recordset) {
    console.log(`  pk=${row.session_pk} tenant=${row.tenant_id} site=${row.site_id} email=${row.email} status=${row.status || '-'} created=${row.created_at?.toISOString?.() || row.created_at}`);
  }
  await services.close();
}
main().catch(e => { console.error(e); process.exit(1); });
