// Quick peek at the test site's current state in arion.site
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const SITE_ID = process.argv[2] || 'ed1cbb72-01b8-4b37-8b01-7b73b3941367';

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
  const r = await pool.request().input('siteId', sql.UniqueIdentifier, SITE_ID).query(`
    SELECT site_id, domain, provisioning_state, status, wp_admin_url, hostinger_website_id, updated_at,
           provisioning_details_json
    FROM arion.site WHERE site_id = @siteId
  `);
  if (r.recordset.length === 0) { console.log('no row'); await pool.close(); return; }
  const row = r.recordset[0];
  console.log('domain=' + row.domain);
  console.log('state=' + row.provisioning_state);
  console.log('status=' + row.status);
  console.log('hostinger_website_id=' + row.hostinger_website_id);
  console.log('updated_at=' + (row.updated_at?.toISOString?.() || row.updated_at));
  try {
    const d = JSON.parse(row.provisioning_details_json || '{}');
    console.log('phase=' + d.current_phase + ' (' + d.current_percent + '%)');
    console.log('msg=' + d.current_message);
    console.log('builder_version=' + d.builder_version);
    console.log('elementor_globals_set=' + d.elementor_globals_set);
    console.log('images_generated=' + d.images_generated);
    console.log('pages_built=' + d.pages_built);
    console.log('front_page_set=' + d.front_page_set);
    if (d.pages_published) console.log('pages_published=' + JSON.stringify(d.pages_published, null, 2));
    if (d.pages_summary) console.log('pages_summary=' + JSON.stringify(d.pages_summary, null, 2));
  } catch (e) { console.log('parse error: ' + e.message); console.log(row.provisioning_details_json?.slice(0, 500)); }
  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
