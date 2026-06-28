// Final post-onboarding verification probe — exercises the live site and
// queries the DB row.
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const TEST_DOMAIN = process.env.TEST_DOMAIN || 'arion-test14.intelligentanalyticsdm.com';
const SITE_ID = process.env.SITE_ID;

if (!SITE_ID) {
  console.error('SITE_ID env var required');
  process.exit(1);
}

async function main() {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });

  console.log('==== DB ROW ====');
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, SITE_ID)
    .query(`SELECT site_id, domain, provisioning_state, status, wp_admin_url,
                   hostinger_website_id, branding_primary_color,
                   provisioning_details_json
            FROM arion.site WHERE site_id = @siteId`);
  if (r.recordset.length === 0) {
    console.log('no row');
    process.exit(1);
  }
  const row = r.recordset[0];
  console.log('site_id:', row.site_id);
  console.log('domain:', row.domain);
  console.log('provisioning_state:', row.provisioning_state);
  console.log('wp_admin_url:', row.wp_admin_url);
  console.log('hostinger_website_id:', row.hostinger_website_id);
  console.log('branding_primary_color:', row.branding_primary_color);

  let details = null;
  try { details = row.provisioning_details_json ? JSON.parse(row.provisioning_details_json) : null; } catch {}
  console.log('\n==== provisioning_details_json (key fields) ====');
  if (details) {
    console.log('builder_version:', details.builder_version);
    console.log('current_phase:', details.current_phase);
    console.log('current_percent:', details.current_percent);
    console.log('elementor_globals_set:', details.elementor_globals_set);
    console.log('elementor_globals_error:', details.elementor_globals_error);
    console.log('images_generated:', details.images_generated);
    console.log('images_failed:', details.images_failed);
    console.log('pages_built:', details.pages_built);
    console.log('pages_published:', JSON.stringify(details.pages_published, null, 2));
    console.log('front_page_set:', details.front_page_set);
    console.log('front_page_error:', details.front_page_error);
    console.log('copy_source:', details.copy_source);
    console.log('plugins_installed:', details.plugins_installed);
    console.log('plugins_failed:', details.plugins_failed);
    if (details.images_errors) {
      console.log('images_errors:', JSON.stringify(details.images_errors, null, 2));
    }
    if (details.pages_summary) {
      console.log('pages_summary:', JSON.stringify(details.pages_summary, null, 2));
    }
  }

  console.log('\n==== lumen.ai_usage telemetry ====');
  try {
    const aiUsagePool = await sql.connect({
      server: 'sql-iadm-prod-cus.database.windows.net',
      database: 'iadm_services',
      options: { encrypt: true, trustServerCertificate: false },
      authentication: { type: 'azure-active-directory-access-token', options: { token: (await credential.getToken('https://database.windows.net/.default')).token } },
    });
    const tenantId = details?.welcome_token ? null : null; // not available, fetch from site row
    const siteRowRes = await pool.request()
      .input('siteId', sql.UniqueIdentifier, SITE_ID)
      .query(`SELECT tenant_id FROM arion.site WHERE site_id = @siteId`);
    const tid = siteRowRes.recordset[0]?.tenant_id;
    if (tid) {
      const ai = await pool.request()
        .input('tid', sql.UniqueIdentifier, tid)
        .query(`SELECT sub_kind, ok, cost_usd, latency_ms, error_code,
                       JSON_VALUE(meta_json, '$.source') AS source,
                       JSON_VALUE(meta_json, '$.slot')   AS slot,
                       occurred_at
                FROM lumen.ai_usage
                WHERE tenant_id = @tid
                  AND surface = 'arion.website_builder'
                ORDER BY occurred_at DESC`);
      console.log(`Found ${ai.recordset.length} ai_usage rows`);
      for (const r of ai.recordset) {
        console.log(`  ${r.occurred_at?.toISOString?.()} sub_kind=${r.sub_kind} ok=${r.ok} slot=${r.slot} source=${r.source} cost=${r.cost_usd} latency=${r.latency_ms}ms err=${r.error_code || '-'}`);
      }
    }
  } catch (e) {
    console.warn('ai_usage query failed:', e.message);
  }

  await pool.close();

  console.log('\n==== HTTP PROBES ====');
  // 1. Homepage
  try {
    const res = await fetch(`https://${TEST_DOMAIN}/`, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
    console.log(`GET https://${TEST_DOMAIN}/ -> HTTP ${res.status}`);
    if (res.status === 200) {
      const html = await res.text();
      const hasRoller = html.toLowerCase().includes('roller');
      const hasHelloWorld = html.toLowerCase().includes('hello world');
      const hasElementor = html.toLowerCase().includes('elementor');
      console.log(`  html_length: ${html.length}`);
      console.log(`  contains_roller: ${hasRoller}`);
      console.log(`  contains_hello_world: ${hasHelloWorld}`);
      console.log(`  contains_elementor: ${hasElementor}`);
      console.log(`  first 500 chars: ${html.slice(0, 500).replace(/\n/g, ' ')}`);
    }
  } catch (e) {
    console.log(`GET / failed: ${e.message}`);
  }

  // 2. WP pages
  try {
    const res = await fetch(`https://${TEST_DOMAIN}/wp-json/wp/v2/pages?per_page=20`, { signal: AbortSignal.timeout(15000) });
    console.log(`\nGET /wp-json/wp/v2/pages -> HTTP ${res.status}`);
    if (res.ok) {
      const arr = await res.json();
      console.log(`  ${Array.isArray(arr) ? arr.length : '?'} pages returned`);
      if (Array.isArray(arr)) {
        for (const p of arr) {
          console.log(`    id=${p.id} slug=${p.slug} title="${p.title?.rendered}" status=${p.status} link=${p.link}`);
        }
      }
    } else {
      const txt = await res.text();
      console.log(`  body: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`GET /wp-json/wp/v2/pages failed: ${e.message}`);
  }

  // 3. Elementor globals
  try {
    const res = await fetch(`https://${TEST_DOMAIN}/wp-json/elementor/v1/globals`, { signal: AbortSignal.timeout(15000) });
    console.log(`\nGET /wp-json/elementor/v1/globals -> HTTP ${res.status}`);
    if (res.ok) {
      const j = await res.json();
      console.log(`  ${JSON.stringify(j, null, 2).slice(0, 1500)}`);
    } else {
      const txt = await res.text();
      console.log(`  body: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`GET /wp-json/elementor/v1/globals failed: ${e.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
