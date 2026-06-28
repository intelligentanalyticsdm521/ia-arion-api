// Poll the ARION runner phase for the overnight auto-test tenant.
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const DOMAIN = 'arion-test12.intelligentanalyticsdm.com';

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
  const r = await pool.request().input('domain', sql.NVarChar, DOMAIN).query(`
    SELECT TOP 5 site_id, tenant_id, domain, status_phase, plugin_status, provisioning_state,
           updated_at, created_at, provisioning_details_json
    FROM arion.site
    WHERE domain = @domain
    ORDER BY updated_at DESC
  `);
  if (r.recordset.length === 0) { console.log('NO_ROW'); await pool.close(); return; }
  for (const row of r.recordset) {
    console.log('---');
    console.log('site_id=' + row.site_id);
    console.log('tenant_id=' + row.tenant_id);
    console.log('domain=' + row.domain);
    console.log('status_phase=' + row.status_phase);
    console.log('plugin_status=' + row.plugin_status);
    console.log('provisioning_state=' + row.provisioning_state);
    console.log('updated_at=' + (row.updated_at?.toISOString?.() || row.updated_at));
    console.log('created_at=' + (row.created_at?.toISOString?.() || row.created_at));
    let d = {};
    try {
      d = JSON.parse(row.provisioning_details_json || '{}');
    } catch (e) {
      console.log('parse_err=' + e.message);
    }
    console.log('current_phase=' + d.current_phase);
    console.log('current_percent=' + d.current_percent);
    console.log('current_message=' + d.current_message);
    console.log('error_json=' + JSON.stringify(d.error_json));
    console.log('google_setup_mode=' + d.google_setup_mode);
    console.log('bing_setup_mode=' + d.bing_setup_mode);
    if (d.history) console.log('history=' + JSON.stringify(d.history));
    if (d.runner_log) console.log('runner_log=' + JSON.stringify(d.runner_log).slice(0, 400));
  }
  await pool.close();
}
main().catch(e => { console.error('ERR:' + e.message); process.exit(1); });
