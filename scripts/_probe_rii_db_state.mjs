#!/usr/bin/env node
/**
 * Query arion.site for Rolling In It to see provisioning_details_json
 * (especially plugins_installed / plugins_skipped / plugins_failed).
 */
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const TENANT_ID = '12839687-67FA-4144-A152-1219D1A64901';
const SITE_ID   = '4E3B2AE2-4133-4813-84AA-4196661ED6F9';

async function getToken() {
  const cred = new DefaultAzureCredential();
  const tok = await cred.getToken('https://database.windows.net/.default');
  return tok.token;
}

async function main() {
  const accessToken = await getToken();
  const pool = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: accessToken } },
  });
  const r = await pool.request()
    .input('sid', sql.UniqueIdentifier, SITE_ID)
    .query(`
      SELECT site_id, tenant_id, domain, domain_mode,
             provisioning_state, status_phase,
             plugin_status, plugin_version,
             provisioning_details_json,
             provisioned_at, created_at, updated_at
      FROM arion.site
      WHERE site_id = @sid
    `);
  const row = r.recordset[0];
  if (!row) {
    console.error('NO ROW for site_id', SITE_ID);
    process.exit(2);
  }
  console.log('site_id           ', row.site_id);
  console.log('tenant_id         ', row.tenant_id);
  console.log('domain            ', row.domain);
  console.log('domain_mode       ', row.domain_mode);
  console.log('provisioning_state', row.provisioning_state);
  console.log('status_phase      ', row.status_phase);
  console.log('plugin_status     ', row.plugin_status);
  console.log('plugin_version    ', row.plugin_version);
  console.log('provisioned_at    ', row.provisioned_at);
  console.log('created_at        ', row.created_at);
  console.log('updated_at        ', row.updated_at);

  if (row.provisioning_details_json) {
    try {
      const j = JSON.parse(row.provisioning_details_json);
      console.log('\nPROVISIONING DETAILS (parsed):');
      // Show only the plugin-relevant + headline keys
      const keys = ['flow', 'tier', 'wp_admin_login', 'plugin_install_status', 'plugin_install_error',
        'plugins_installed', 'plugins_skipped', 'plugins_failed', 'install_shop', 'publish_pdfs',
        'current_phase', 'current_percent', 'current_message',
        'builder_version', 'elementor_globals_set', 'elementor_globals_error',
        'front_page_set', 'front_page_error', 'welcome_email_status', 'welcome_email_error',
        'images_generated', 'images_failed', 'pages_built'];
      for (const k of keys) {
        if (k in j) console.log(`  ${k.padEnd(28)} = ${JSON.stringify(j[k])}`);
      }
      console.log('\n(all keys present:', Object.keys(j).join(', '), ')');
    } catch (e) {
      console.error('JSON parse failed:', e.message);
      console.log('RAW:', row.provisioning_details_json.slice(0, 2000));
    }
  } else {
    console.log('(no provisioning_details_json)');
  }
  await pool.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
