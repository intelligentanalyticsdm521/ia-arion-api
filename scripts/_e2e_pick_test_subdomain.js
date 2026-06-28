// Find the next free arion-test<N>.intelligentanalyticsdm.com slot
// Used by the V2 onboarding pipeline verifier.
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

  const r = await pool.request().query(`
    SELECT site_id, domain, provisioning_state, created_at,
           JSON_VALUE(provisioning_details_json, '$.current_phase') AS current_phase
    FROM arion.site
    WHERE domain LIKE 'arion-test%.intelligentanalyticsdm.com'
    ORDER BY domain
  `);
  console.log('Existing test sites:');
  for (const row of r.recordset) {
    console.log(`  ${row.domain}  state=${row.provisioning_state}  phase=${row.current_phase || '-'}  created=${row.created_at?.toISOString?.() || row.created_at}`);
  }
  // Pick next free number
  const used = new Set();
  for (const row of r.recordset) {
    const m = /arion-test(\d+)\.intelligentanalyticsdm\.com/i.exec(row.domain);
    if (m) used.add(parseInt(m[1], 10));
  }
  let next = 1;
  while (used.has(next)) next++;
  console.log(`\nNext free: arion-test${next}.intelligentanalyticsdm.com`);
  await pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
