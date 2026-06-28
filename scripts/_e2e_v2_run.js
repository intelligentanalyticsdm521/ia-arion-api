// E2E verifier for AI WB V2 Elementor onboarding pipeline.
// 1) Seed a fresh arion.signup_session row for a synthetic test.
// 2) POST /onboarding/submit with byod mode + a fake stripe_session_id.
// 3) Poll /onboarding/status until ready / failed / timeout.
// 4) Dump arion.site.provisioning_details_json so we can read pipeline outcomes.
//
// IMPORTANT — this actually provisions a real Hostinger website slot. Run only
// on the prod arion-api when you're verifying the V2 pipeline against a fresh
// arion-test<N>.intelligentanalyticsdm.com subdomain.

import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import crypto from 'node:crypto';

const TEST_DOMAIN = process.env.TEST_DOMAIN || 'arion-test13.intelligentanalyticsdm.com';
const API_BASE = 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';
const STRIPE_SESSION_ID = 'cs_arion_test_v2_' + Date.now();

const SQL_SERVER = 'sql-iadm-prod-cus.database.windows.net';

async function getPool(database) {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = new sql.ConnectionPool({
    server: SQL_SERVER,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });
  await pool.connect();
  return pool;
}

async function step1_seedSession() {
  console.log(`\n[1] Seeding arion.signup_session for ${TEST_DOMAIN}`);
  const platformPool = await getPool('iadm_platform');
  const servicesPool = await getPool('iadm_services');

  // Generate tenant + site + user
  const tenantId = crypto.randomUUID();
  const siteId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const email = `arion-test-v2-${Date.now()}@intelligentanalyticsdm.com`;
  const tenantSlug = `arion-test-v2-${Date.now()}`.slice(0, 60);

  // Insert tenant
  const tenantNameSuffix = Date.now().toString(36).slice(-6);
  await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('name', sql.NVarChar(200), `V2 E2E Test Tenant ${tenantNameSuffix}`)
    .input('fullName', sql.NVarChar(200), `V2 AI WB E2E Test ${tenantNameSuffix}`)
    .input('slug', sql.NVarChar(63), tenantSlug)
    .input('status', sql.NVarChar(20), 'active')
    .input('tier', sql.NVarChar(20), 'standard')
    .input('website', sql.NVarChar(400), `https://${TEST_DOMAIN}`)
    .query(`INSERT INTO core.tenants (tenant_id, name, full_name, slug, status, subscription_tier, website_url)
            VALUES (@tid, @name, @fullName, @slug, @status, @tier, @website)`);

  // Insert user
  const IDENTITY_PROVIDER_ID = '696CA25F-0011-F111-A69A-00224848050B';
  await platformPool.request()
    .input('uid', sql.UniqueIdentifier, userId)
    .input('idpId', sql.UniqueIdentifier, IDENTITY_PROVIDER_ID)
    .input('extSub', sql.NVarChar(254), email)
    .input('email', sql.NVarChar(254), email)
    .input('firstName', sql.NVarChar(100), 'V2')
    .input('lastName', sql.NVarChar(100), 'Test')
    .input('fullName', sql.NVarChar(200), 'V2 Test')
    .input('status', sql.NVarChar(20), 'active')
    .query(`INSERT INTO core.users (user_id, identity_provider_id, external_subject, email, first_name, last_name, full_name, status)
            VALUES (@uid, @idpId, @extSub, @email, @firstName, @lastName, @fullName, @status)`);

  await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uid', sql.UniqueIdentifier, userId)
    .input('status', sql.NVarChar(20), 'active')
    .query(`INSERT INTO core.tenant_users (tenant_id, user_id, status) VALUES (@tid, @uid, @status)`);

  // Enable ARION
  const ARION_SERVICE_ID = '44444444-4444-4444-4444-444444444444';
  await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('sid', sql.UniqueIdentifier, ARION_SERVICE_ID)
    .query(`INSERT INTO core.tenant_services (tenant_id, service_id, is_enabled) VALUES (@tid, @sid, 1)`);

  // Insert arion.site (minimum required cols)
  const rawTokenBytes = crypto.randomBytes(64);
  const tokenHash = rawTokenBytes.toString('hex').slice(0, 64);
  await servicesPool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('hostingPlan', sql.NVarChar(50), 'managed')
    .input('status', sql.NVarChar(50), 'awaiting_setup')
    .input('tier', sql.NVarChar(20), 'standard')
    .input('tokenHash', sql.NVarChar(64), tokenHash)
    .input('flagOff', sql.Bit, 0)
    .query(`INSERT INTO arion.site (site_id, tenant_id, hosting_plan, status, arion_tier, site_token_hash,
              site_token_last_rotated, gbp_connected, gsc_connected, google_ads_linked, apple_claimed, created_at, updated_at)
            VALUES (@siteId, @tid, @hostingPlan, @status, @tier, @tokenHash,
              SYSDATETIMEOFFSET(), @flagOff, @flagOff, @flagOff, @flagOff, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())`);

  // Seed signup_session
  await servicesPool.request()
    .input('stripeId', sql.NVarChar(200), STRIPE_SESSION_ID)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('email', sql.NVarChar(254), email)
    .query(`INSERT INTO arion.signup_session (stripe_session_id, tenant_id, site_id, email, created_at)
            VALUES (@stripeId, @tid, @siteId, @email, SYSDATETIMEOFFSET())`);

  console.log(`    tenant_id=${tenantId}`);
  console.log(`    site_id=${siteId}`);
  console.log(`    user_id=${userId}`);
  console.log(`    email=${email}`);
  console.log(`    stripe_session_id=${STRIPE_SESSION_ID}`);

  await platformPool.close();
  await servicesPool.close();
  return { tenantId, siteId, userId, email };
}

async function step2_postSubmit() {
  console.log(`\n[2] POST /onboarding/submit for ${TEST_DOMAIN}`);
  const body = {
    session_id: STRIPE_SESSION_ID,
    domain: { mode: 'byod', domain: TEST_DOMAIN },
    answers: {
      businessName: 'Test Roller Rink',
      industry: 'entertainment',
      description: 'A family-friendly roller skating rink with parties, lessons, and a snack bar.',
      tagline: 'Skate where the fun rolls in',
      services: ['Open skate', 'Private parties', 'Skating lessons', 'Concessions'],
      brandVoice: 'fun, energetic, family-friendly',
      stylePreference: 'modern',
      targetAudience: 'families and kids',
      location: 'Dallas, TX',
      primaryColor: '#FEC82C',
      secondaryColor: '#1A3A4A',
      accentColor: '#E91E63',
      contactEmail: 'info@testrollerrink.example',
      contactPhone: '555-867-5309',
      contactAddress: '123 Skate Way, Dallas, TX 75201',
      tier: 'standard',
      contactFirstName: 'V2',
      contactLastName: 'Test',
      hasExistingWebsite: false,
    },
  };
  const start = Date.now();
  const res = await fetch(API_BASE + '/onboarding/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`    HTTP ${res.status} ${(Date.now() - start)}ms`);
  console.log(`    Response: ${text.slice(0, 600)}`);
  if (![200, 202].includes(res.status)) {
    throw new Error(`submit failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function step3_pollStatus(timeoutMs = 25 * 60 * 1000) {
  console.log(`\n[3] Polling /onboarding/status until ready/failed (timeout ${timeoutMs/60000}min)`);
  const start = Date.now();
  let lastPhase = null;
  const phaseHistory = [];
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(API_BASE + `/onboarding/status?session_id=${encodeURIComponent(STRIPE_SESSION_ID)}`);
      const j = await res.json();
      const phase = j.data?.phase;
      const percent = j.data?.progress_percent;
      const msg = j.data?.message;
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`    +${elapsed}s phase=${phase} (${percent}%) — ${msg || ''}`);
        phaseHistory.push({ phase, percent, msg, elapsed_s: parseFloat(elapsed) });
        lastPhase = phase;
      }
      if (phase === 'ready' || phase === 'ready_partial' || phase === 'failed') {
        console.log(`    Terminal phase reached: ${phase}`);
        return { final: j.data, phaseHistory };
      }
    } catch (e) {
      console.warn('    poll error:', e.message);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return { final: null, phaseHistory, timedOut: true };
}

async function step4_dumpDetails(siteId) {
  console.log(`\n[4] Dumping arion.site row for ${siteId}`);
  const pool = await getPool('iadm_services');
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(`SELECT site_id, domain, provisioning_state, status, wp_admin_url,
                   hostinger_website_id, branding_primary_color,
                   provisioning_details_json
            FROM arion.site WHERE site_id = @siteId`);
  await pool.close();
  if (r.recordset.length === 0) { console.log('    NO ROW FOUND'); return null; }
  const row = r.recordset[0];
  console.log('    site_id=' + row.site_id);
  console.log('    domain=' + row.domain);
  console.log('    state=' + row.provisioning_state);
  console.log('    wp_admin_url=' + row.wp_admin_url);
  console.log('    hostinger_website_id=' + row.hostinger_website_id);
  let details = null;
  try { details = row.provisioning_details_json ? JSON.parse(row.provisioning_details_json) : null; } catch (e) {}
  console.log('\n    provisioning_details_json:');
  console.log(JSON.stringify(details, null, 2));
  return { row, details };
}

async function step5_probeSite() {
  console.log(`\n[5] Probing https://${TEST_DOMAIN}/ + pages`);
  const out = { homepage: null, pages: null, globals: null };
  try {
    const res = await fetch(`https://${TEST_DOMAIN}/`, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
    out.homepage = { status: res.status, headers: Object.fromEntries(res.headers) };
    if (res.status === 200) {
      const html = await res.text();
      out.homepage.html_length = html.length;
      out.homepage.has_test_roller_rink = html.includes('Test Roller Rink') || html.toLowerCase().includes('roller');
      out.homepage.has_elementor = html.includes('elementor');
    }
  } catch (e) { out.homepage = { error: e.message }; }

  try {
    const res = await fetch(`https://${TEST_DOMAIN}/wp-json/wp/v2/pages?per_page=20`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const arr = await res.json();
      out.pages = Array.isArray(arr) ? arr.map((p) => ({
        id: p.id, slug: p.slug, title: p.title?.rendered, link: p.link, status: p.status,
      })) : null;
    } else {
      out.pages = { error: `HTTP ${res.status}` };
    }
  } catch (e) { out.pages = { error: e.message }; }

  try {
    const res = await fetch(`https://${TEST_DOMAIN}/wp-json/elementor/v1/globals`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      out.globals = await res.json();
    } else {
      out.globals = { error: `HTTP ${res.status}` };
    }
  } catch (e) { out.globals = { error: e.message }; }

  console.log(JSON.stringify(out, null, 2));
  return out;
}

(async () => {
  console.log('==== AI WB V2 E2E VERIFIER ====');
  console.log('Test domain: ' + TEST_DOMAIN);
  console.log('API base: ' + API_BASE);
  console.log('Stripe session: ' + STRIPE_SESSION_ID);

  let ctx;
  try { ctx = await step1_seedSession(); }
  catch (e) { console.error('SEED FAILED:', e.message); process.exit(1); }

  try { await step2_postSubmit(); }
  catch (e) {
    console.error('SUBMIT FAILED:', e.message);
    await step4_dumpDetails(ctx.siteId);
    process.exit(1);
  }

  const poll = await step3_pollStatus(25 * 60 * 1000);
  const details = await step4_dumpDetails(ctx.siteId);
  let probe = null;
  if (poll.final?.phase === 'ready' || poll.final?.phase === 'ready_partial') {
    probe = await step5_probeSite();
  }

  // Final report
  console.log('\n==== FINAL REPORT ====');
  console.log('tenant_id=' + ctx.tenantId);
  console.log('site_id=' + ctx.siteId);
  console.log('terminal_phase=' + (poll.final?.phase || (poll.timedOut ? 'TIMEOUT' : 'unknown')));
  console.log('phase_history:');
  for (const p of poll.phaseHistory) console.log(`  +${p.elapsed_s}s ${p.phase} (${p.percent}%)`);
  if (details?.details) {
    console.log('\nelementor_globals_set: ' + details.details.elementor_globals_set);
    console.log('images_generated: ' + details.details.images_generated);
    console.log('pages_built: ' + details.details.pages_built);
    console.log('front_page_set: ' + details.details.front_page_set);
    console.log('builder_version: ' + details.details.builder_version);
  }
  process.exit(poll.final?.phase === 'ready' ? 0 : 1);
})();
