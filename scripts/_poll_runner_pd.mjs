import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

async function main() {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });
  await pool.connect();
  const r = await pool.request().query(`
    SELECT TOP 1 site_id, status_phase, updated_at, provisioning_details_json
    FROM arion.site
    WHERE domain = 'arion-test12.intelligentanalyticsdm.com'
    ORDER BY created_at DESC
  `);
  console.log(JSON.stringify(r.recordset, null, 2));
  await pool.close();
}
main().catch(e => { console.error('ERR:' + e.message); process.exit(1); });
