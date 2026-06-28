// Dump arion.site row + platform event history for the overnight auto-test tenant.
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
    SELECT TOP 1 site_id, tenant_id, domain, status_phase, plugin_status, provisioning_state,
           updated_at, created_at, provisioning_details_json,
           google_setup_mode, bing_setup_mode, gsc_connected, bing_ownership_transferred_at,
           wp_admin_url, status, tier, feature_addons_json
    FROM arion.site
    WHERE domain = @domain
    ORDER BY created_at DESC
  `);
  if (r.recordset.length === 0) { console.log('NO_ROW'); await pool.close(); return; }
  const row = r.recordset[0];
  console.log('=== site row ===');
  console.log('site_id=' + row.site_id);
  console.log('tenant_id=' + row.tenant_id);
  console.log('status_phase=' + row.status_phase);
  console.log('plugin_status=' + row.plugin_status);
  console.log('provisioning_state=' + row.provisioning_state);
  console.log('status=' + row.status);
  console.log('tier=' + row.tier);
  console.log('updated_at=' + (row.updated_at?.toISOString?.()));
  console.log('created_at=' + (row.created_at?.toISOString?.()));
  console.log('google_setup_mode=' + row.google_setup_mode);
  console.log('bing_setup_mode=' + row.bing_setup_mode);
  console.log('gsc_connected=' + row.gsc_connected);
  console.log('bing_ownership_transferred_at=' + row.bing_ownership_transferred_at);
  console.log('wp_admin_url=' + row.wp_admin_url);
  console.log('feature_addons_json=' + row.feature_addons_json);
  console.log('provisioning_details_json (raw, 2000 char limit)=');
  console.log((row.provisioning_details_json || '(null)').slice(0, 2000));

  // Try platform events for this site
  try {
    const evt = await pool.request().input('sid', sql.UniqueIdentifier, row.site_id).query(`
      SELECT TOP 50 event_type, payload_json, created_at
      FROM core.platform_event
      WHERE TRY_CONVERT(uniqueidentifier, JSON_VALUE(payload_json, '$.site_id')) = @sid
         OR JSON_VALUE(payload_json, '$.site_id') = CAST(@sid AS NVARCHAR(64))
      ORDER BY created_at DESC
    `);
    console.log('=== platform events for site (' + evt.recordset.length + ') ===');
    for (const e of evt.recordset) {
      console.log(`  ${e.created_at?.toISOString?.()} ${e.event_type}`);
      console.log(`    payload: ${(e.payload_json || '').slice(0, 300)}`);
    }
  } catch (e) {
    console.log('platform_event lookup err: ' + e.message);
  }

  // Check site integration status
  try {
    const ints = await pool.request().input('sid', sql.UniqueIdentifier, row.site_id).query(`
      SELECT integration_key, status, updated_at, created_at, last_error
      FROM arion.site_integration_status
      WHERE site_id = @sid
      ORDER BY updated_at DESC
    `);
    console.log('=== site_integration_status (' + ints.recordset.length + ') ===');
    for (const i of ints.recordset) {
      console.log(`  ${i.integration_key}=${i.status} (updated ${i.updated_at?.toISOString?.()})`);
      if (i.last_error) console.log(`    last_error=${i.last_error.slice(0, 200)}`);
    }
  } catch (e) {
    console.log('site_integration_status lookup err: ' + e.message);
  }

  await pool.close();
}
main().catch(e => { console.error('ERR:' + e.message); process.exit(1); });
