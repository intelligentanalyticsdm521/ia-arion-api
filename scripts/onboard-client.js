import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import crypto from 'crypto';

// --- Arg Parsing -------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--')) throw new Error('Expected --flag, got: ' + args[i]);
    parsed[args[i].slice(2)] = args[i + 1];
  }
  if (!parsed.tenantId && !parsed.name) {
    console.error('Error: either --tenantId or --name is required.');
    process.exit(1);
  }
  if (!parsed.domain) { console.error('Error: --domain is required.'); process.exit(1); }
  if (!parsed.email)  { console.error('Error: --email is required.');  process.exit(1); }
  return parsed;
}

// --- Constants ---------------------------------------------------------------
const SQL_SERVER = 'sql-iadm-prod-cus.database.windows.net';
const IDENTITY_PROVIDER_ID = '696CA25F-0011-F111-A69A-00224848050B';
// Per convention_never_hardcode_service_ids: NEVER hardcode service_ids.
// SERVICE_IDS is hydrated at startup from core.services via loadServiceIds().
// The values below are HARDCODED FALLBACKS ONLY — used with a console.warn
// if the DB row is missing for a key. Safe-rollback pattern.
const HARDCODED_FALLBACK_SERVICE_IDS = {
  arion:  '44444444-4444-4444-4444-444444444444',
  spark:  '1150C64A-4E4C-476E-A89E-2A5073826672',
  oliver: '33333333-3333-3333-3333-333333333333',
  stella: '55555555-5555-5555-5555-555555555555',
  forge:  '7EB0DCAD-584F-4B16-9D3B-547799AAAE58',
  argus:  'F00C7716-97D5-4B2F-9050-A45F4394E364',
};
let SERVICE_IDS = {};

async function loadServiceIds(platformPool) {
  try {
    const r = await platformPool.request().query(
      'SELECT service_key, service_id FROM core.services'
    );
    const map = {};
    for (const row of r.recordset) {
      if (row.service_key) map[String(row.service_key).toLowerCase()] = row.service_id;
    }
    // Overlay: prefer DB value; fall back to hardcode with warn per-key.
    const merged = {};
    const keys = new Set([...Object.keys(HARDCODED_FALLBACK_SERVICE_IDS), ...Object.keys(map)]);
    for (const k of keys) {
      if (map[k]) {
        merged[k] = map[k];
      } else if (HARDCODED_FALLBACK_SERVICE_IDS[k]) {
        console.warn("  ! core.services has no row for service_key='" + k + "' — falling back to hardcoded " + HARDCODED_FALLBACK_SERVICE_IDS[k]);
        merged[k] = HARDCODED_FALLBACK_SERVICE_IDS[k];
      }
    }
    return merged;
  } catch (err) {
    console.warn('  ! loadServiceIds() failed (' + err.message + '); using hardcoded fallback map.');
    return { ...HARDCODED_FALLBACK_SERVICE_IDS };
  }
}
const API_URL = 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

// --- Database Helpers --------------------------------------------------------
async function getPool(database) {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  return sql.connect({
    server: SQL_SERVER,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: tokenRes.token },
    },
  });
}

// --- Step 3: Find or create tenant -------------------------------------------
async function findOrCreateTenant(pool, args) {
  if (args.tenantId) {
    const res = await pool.request()
      .input('tid', sql.UniqueIdentifier, args.tenantId)
      .query('SELECT tenant_id, name, full_name FROM core.tenants WHERE tenant_id = @tid');
    if (!res.recordset.length) {
      console.error('Tenant ' + args.tenantId + ' not found.');
      process.exit(1);
    }
    const t = res.recordset[0];
    console.log('  Found tenant: ' + (t.full_name || t.name) + ' (' + t.tenant_id + ')');
    return t;
  }

  const existing = await pool.request()
    .input('name', sql.NVarChar, args.name)
    .query('SELECT tenant_id, name, full_name FROM core.tenants WHERE name = @name');
  if (existing.recordset.length) {
    const t = existing.recordset[0];
    console.log('  Found existing tenant: ' + (t.full_name || t.name) + ' (' + t.tenant_id + ')');
    return t;
  }

  const newId = crypto.randomUUID();
  const fullName = args.fullName || args.name;
  const tier = args.tier || 'standard';
  await pool.request()
    .input('tid', sql.UniqueIdentifier, newId)
    .input('name', sql.NVarChar, args.name)
    .input('fullName', sql.NVarChar, fullName)
    .input('status', sql.NVarChar, 'active')
    .input('tier', sql.NVarChar, tier)
    .input('website', sql.NVarChar, args.domain)
    .query(
      'INSERT INTO core.tenants (tenant_id, name, full_name, status, subscription_tier, website_url) ' +
      'VALUES (@tid, @name, @fullName, @status, @tier, @website)'
    );
  console.log('  Created tenant: ' + fullName + ' (' + newId + ')');
  return { tenant_id: newId, name: args.name, full_name: fullName };
}

// --- Step 4: Find or create user ---------------------------------------------
async function findOrCreateUser(pool, args) {
  const existing = await pool.request()
    .input('email', sql.NVarChar, args.email)
    .query('SELECT user_id, email, first_name, last_name, full_name FROM core.users WHERE email = @email');
  if (existing.recordset.length) {
    const u = existing.recordset[0];
    console.log('  Found existing user: ' + (u.full_name || u.email) + ' (' + u.user_id + ')');
    return u;
  }

  const newId = crypto.randomUUID();
  const firstName = args.firstName || '';
  const lastName = args.lastName || '';
  const fullName = (firstName && lastName) ? firstName + ' ' + lastName : args.email;
  await pool.request()
    .input('uid', sql.UniqueIdentifier, newId)
    .input('idpId', sql.UniqueIdentifier, IDENTITY_PROVIDER_ID)
    .input('extSub', sql.NVarChar, args.email)
    .input('email', sql.NVarChar, args.email)
    .input('firstName', sql.NVarChar, firstName)
    .input('lastName', sql.NVarChar, lastName)
    .input('fullName', sql.NVarChar, fullName)
    .input('status', sql.NVarChar, 'active')
    .query(
      'INSERT INTO core.users (user_id, identity_provider_id, external_subject, email, first_name, last_name, full_name, status) ' +
      'VALUES (@uid, @idpId, @extSub, @email, @firstName, @lastName, @fullName, @status)'
    );
  console.log('  Created user: ' + fullName + ' (' + newId + ')');
  return { user_id: newId, email: args.email, first_name: firstName, last_name: lastName, full_name: fullName };
}

// --- Step 5: Link user to tenant ---------------------------------------------
//
// 2026-06-26 — bug fix. Previously this unconditionally inserted (tenant_id,
// user_id) into core.tenant_users. When the script was run with a founder/IA
// email by mistake, it linked the founder to the client tenant — which then
// surfaced the client tenant in the founder's tenant picker as if it were
// "theirs". Now: if the user being linked is a platform-role founder/super
// admin, refuse the link and instruct the caller to supply the actual buyer's
// email instead (or rely on the CIAM invitation flow to claim membership).
async function linkUserToTenant(pool, tenantId, userId) {
  const founderCheck = await pool.request()
    .input('uid', sql.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1 1 AS yes
        FROM core.user_platform_roles upr
        JOIN core.platform_roles pr ON pr.platform_role_id = upr.platform_role_id
       WHERE upr.user_id = @uid
         AND upr.is_active = 1
         AND pr.is_active = 1
         AND (pr.role_key IN ('founder','super_admin') OR pr.name = 'SUPER_ADMIN')
    `);
  if (founderCheck.recordset.length) {
    console.warn('  ! Refusing to link founder/super-admin to a client tenant.');
    console.warn('    Run again with the client owner\'s email, or skip linking and let');
    console.warn('    them claim membership via the CIAM invitation flow.');
    return;
  }

  const existing = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uid', sql.UniqueIdentifier, userId)
    .query('SELECT 1 FROM core.tenant_users WHERE tenant_id = @tid AND user_id = @uid');
  if (existing.recordset.length) {
    console.log('  User already linked to tenant.');
    return;
  }
  await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uid', sql.UniqueIdentifier, userId)
    .input('status', sql.NVarChar, 'active')
    .query('INSERT INTO core.tenant_users (tenant_id, user_id, status) VALUES (@tid, @uid, @status)');
  console.log('  Linked user to tenant.');
}

// --- Step 6: Enable services -------------------------------------------------
async function enableServices(pool, tenantId, servicesCsv) {
  const serviceNames = (servicesCsv || 'arion').split(',').map(s => s.trim().toLowerCase());
  const enabled = [];
  for (const svc of serviceNames) {
    const svcId = SERVICE_IDS[svc];
    if (!svcId) {
      console.warn("  Warning: unknown service \"" + svc + "\", skipping.");
      continue;
    }
    const existing = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('sid', sql.UniqueIdentifier, svcId)
      .query('SELECT 1 FROM core.tenant_services WHERE tenant_id = @tid AND service_id = @sid');
    if (existing.recordset.length) {
      console.log("  Service \"" + svc + "\" already enabled.");
      enabled.push(svc);
      continue;
    }
    await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('sid', sql.UniqueIdentifier, svcId)
      .input('status', sql.NVarChar, 'active')
      .query('INSERT INTO core.tenant_services (tenant_id, service_id, status) VALUES (@tid, @sid, @status)');
    console.log('  Enabled service: ' + svc);
    enabled.push(svc);
  }
  return enabled;
}

// --- Step 7: Create ARION site -----------------------------------------------
async function createArionSite(pool, tenantId, args) {
  const existing = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('domain', sql.NVarChar, args.domain)
    .query('SELECT site_id, domain, status FROM arion.site WHERE tenant_id = @tid AND domain = @domain');
  if (existing.recordset.length) {
    const s = existing.recordset[0];
    console.log('  Site already exists: ' + s.domain + ' (' + s.site_id + ')');
    return { site_id: s.site_id, domain: s.domain, status: s.status, token: null, isExisting: true };
  }

  const siteId = crypto.randomUUID();
  const token = crypto.randomBytes(64).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const status = args.wpAdminUrl ? 'active' : 'awaiting_setup';
  const tier = args.tier || 'standard';

  await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('domain', sql.NVarChar, args.domain)
    .input('hostingPlan', sql.NVarChar, 'managed')
    .input('wpAdminUrl', sql.NVarChar, args.wpAdminUrl || null)
    .input('status', sql.NVarChar, status)
    .input('tier', sql.NVarChar, tier)
    .input('tokenHash', sql.NVarChar(64), tokenHash)
    .input('flagOff', sql.Bit, 0)
    .query(
      'INSERT INTO arion.site ' +
      '(site_id, tenant_id, domain, hosting_plan, wp_admin_url, status, arion_tier, site_token_hash, ' +
      ' site_token_last_rotated, gbp_connected, gsc_connected, google_ads_linked, apple_claimed, created_at, updated_at) ' +
      'VALUES ' +
      '(@siteId, @tid, @domain, @hostingPlan, @wpAdminUrl, @status, @tier, @tokenHash, ' +
      ' SYSDATETIMEOFFSET(), @flagOff, @flagOff, @flagOff, @flagOff, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())'
    );

  console.log('  Created site: ' + args.domain + ' (' + siteId + ')');
  return { site_id: siteId, domain: args.domain, status: status, token: token, isExisting: false };
}

// --- Step 8: Print summary ---------------------------------------------------
function printSummary(tenant, user, services, site, args) {
  const bar = '\u2550'.repeat(43);
  const tenantDisplay = tenant.full_name
    ? tenant.full_name + ' (' + tenant.name + ')'
    : tenant.name;
  const userDisplay = (user.first_name && user.last_name)
    ? user.first_name + ' ' + user.last_name + ' (' + user.email + ')'
    : user.email;

  console.log('\n' + bar);
  console.log('  ARION Client Onboarding \u2014 Complete');
  console.log(bar);
  console.log();
  console.log('  Tenant:     ' + tenantDisplay);
  console.log('  Tenant ID:  ' + tenant.tenant_id);
  console.log();
  console.log('  User:       ' + userDisplay);
  console.log('  User ID:    ' + user.user_id);
  console.log();
  console.log('  Services:   ' + services.join(', '));
  console.log();
  console.log('  Site:       ' + site.domain);
  console.log('  Site ID:    ' + site.site_id);
  console.log('  Status:     ' + site.status);
  if (args.wpAdminUrl) {
    console.log('  WP Admin:   ' + args.wpAdminUrl);
  }

  if (site.token) {
    console.log();
    console.log('  \u2554' + '\u2550'.repeat(39) + '\u2557');
    console.log('  \u2551  SITE TOKEN (save this \u2014 shown once)  \u2551');
    console.log('  \u2551  ' + site.token + '  \u2551');
    console.log('  \u255a' + '\u2550'.repeat(39) + '\u255d');
  } else {
    console.log();
    console.log('  (Site already existed \u2014 no new token generated)');
  }

  console.log();
  console.log('  Next steps:');
  console.log('  1. Install the Intelligent Analytics plugin on the WordPress site');
  console.log('  2. Go to Settings > Intelligent Analytics');
  console.log('  3. Enter:');
  console.log('     - API URL:    ' + API_URL);
  console.log('     - Tenant ID:  ' + tenant.tenant_id);
  console.log('     - Site ID:    ' + site.site_id);
  if (site.token) {
    console.log('     - Site Token: <the token shown above>');
  }
  console.log();
}

// --- Main --------------------------------------------------------------------
async function main() {
  const args = parseArgs();
  console.log('\n\u25b6 ARION Client Onboarding\n');

  // Step 2: Connect to both databases
  console.log('[1/6] Connecting to databases...');
  let platformPool, servicesPool;
  try {
    platformPool = await getPool('iadm_platform');
    console.log('  Connected to iadm_platform.');
  } catch (err) {
    console.error('Failed to connect to iadm_platform:', err.message);
    process.exit(1);
  }
  try {
    const credential = new DefaultAzureCredential();
    const tokenRes = await credential.getToken('https://database.windows.net/.default');
    servicesPool = new sql.ConnectionPool({
      server: SQL_SERVER,
      database: 'iadm_services',
      options: { encrypt: true, trustServerCertificate: false },
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: tokenRes.token },
      },
    });
    await servicesPool.connect();
    console.log('  Connected to iadm_services.');
  } catch (err) {
    console.error('Failed to connect to iadm_services:', err.message);
    process.exit(1);
  }

  try {
    // Hydrate SERVICE_IDS from core.services before any service-linking step.
    SERVICE_IDS = await loadServiceIds(platformPool);

    console.log('\n[2/6] Finding or creating tenant...');
    const tenant = await findOrCreateTenant(platformPool, args);

    console.log('\n[3/6] Finding or creating user...');
    const user = await findOrCreateUser(platformPool, args);

    console.log('\n[4/6] Linking user to tenant...');
    await linkUserToTenant(platformPool, tenant.tenant_id, user.user_id);

    console.log('\n[5/6] Enabling services...');
    const services = await enableServices(platformPool, tenant.tenant_id, args.services);

    console.log('\n[6/6] Creating ARION site...');
    const site = await createArionSite(servicesPool, tenant.tenant_id, args);

    printSummary(tenant, user, services, site, args);
  } finally {
    await platformPool.close();
    await servicesPool.close();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
