// Full state check — any arion site with V2 builder traces? Any test-* domain?
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

async function main() {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });

  // All sites
  const r1 = await pool.request().query(`
    SELECT site_id, tenant_id, domain, provisioning_state, status, created_at,
           JSON_VALUE(provisioning_details_json,'$.builder_version') AS builder_version,
           JSON_VALUE(provisioning_details_json,'$.current_phase') AS current_phase,
           JSON_VALUE(provisioning_details_json,'$.elementor_globals_set') AS globals_set,
           JSON_VALUE(provisioning_details_json,'$.pages_built') AS pages_built,
           JSON_VALUE(provisioning_details_json,'$.images_generated') AS images_generated
    FROM arion.site
    ORDER BY created_at DESC
  `);
  console.log('All arion.site rows (' + r1.recordset.length + '):');
  for (const row of r1.recordset) {
    console.log('  ' + (row.domain || '<null-domain>') +
      ' | state=' + row.provisioning_state + ' | status=' + row.status +
      ' | v=' + (row.builder_version || '-') + ' | phase=' + (row.current_phase || '-') +
      ' | globals=' + (row.globals_set || '-') + ' | pages=' + (row.pages_built || '-') +
      ' | images=' + (row.images_generated || '-') +
      ' | created=' + (row.created_at?.toISOString?.() || row.created_at));
    console.log('    site_id=' + row.site_id);
  }

  // V2 specific table — site_block_draft (from migration 025)
  try {
    const r2 = await pool.request().query(`
      SELECT COUNT(*) AS n FROM arion.site_block_draft
    `);
    console.log('\nsite_block_draft rows: ' + r2.recordset[0].n);
  } catch (e) {
    console.log('site_block_draft not present: ' + e.message);
  }

  // Onboarding ai-website-builder cost tracking
  try {
    const r3 = await pool.request().query(`
      SELECT TOP 10 *
      FROM lumen.ai_usage
      WHERE service_name='arion_website_builder'
      ORDER BY created_at DESC
    `);
    console.log('\nai_usage (arion_website_builder) rows (' + r3.recordset.length + '):');
    for (const row of r3.recordset) {
      console.log('  ' + row.created_at?.toISOString?.() + ' tenant=' + row.tenant_id + ' model=' + row.model_id + ' usd=' + row.cost_usd);
    }
  } catch (e) {
    console.log('ai_usage query failed: ' + e.message);
  }

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
