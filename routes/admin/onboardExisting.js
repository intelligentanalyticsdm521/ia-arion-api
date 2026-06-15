/**
 * POST /admin/onboard-existing
 * --------------------------------------------------------------------------
 * Founder-side super-admin endpoint to onboard a customer whose WordPress
 * site was built OUTSIDE the standard signup flow (e.g. you manually used
 * Hostinger's Kodee AI builder, or migrated a customer from another host).
 *
 * Does NOT use Stripe checkout. Does NOT provision a new WP site. Just:
 *   1. find/create core.tenants row (by email match if existing)
 *   2. find/create core.users row + link to tenant
 *   3. enable ARION service for the tenant
 *   4. create arion.site row
 *   5. issue a long-TTL (90 day) provisioning code for the IA Plugin
 *   6. send welcome email (existing-website variant)
 *
 * AUTH: Bearer token (env `FOUNDER_ADMIN_TOKEN`). Generate a random value,
 * set it on the App Service env, and embed the same value in the Portal
 * admin page's API client.
 */

import { Router } from 'express';
import sql from 'mssql';
import { webcrypto as crypto } from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';
import { getPlatformPool } from '../../db/platformPool.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';
import { sendOnboardingWelcomeEmail, generateSetupToken } from '../../lib/welcomeEmail.js';

const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

// Identity provider for our shared CIAM (Entra External ID)
const IDENTITY_PROVIDER_ID = '696CA25F-0011-F111-A69A-00224848050B';
const ARION_SERVICE_ID = '44444444-4444-4444-4444-444444444444';

const router = Router();

function requireFounderAuth(req, res, next) {
  const expected = process.env.FOUNDER_ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(500).json({ error: { code: 'NOT_CONFIGURED', message: 'FOUNDER_ADMIN_TOKEN env var is not set on arion-api' } });
  }
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || h.slice(7) !== expected) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Founder admin token required' } });
  }
  next();
}

router.post('/onboard-existing', requireFounderAuth, async (req, res) => {
  const { name, email, domain, tier = 'standard', firstName = '', lastName = '', wpAdminUrl, brandName } = req.body || {};

  if (!name || !email || !domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name, email, and domain are required', status: 400 } });
  }
  const safeDomain = String(domain || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(safeDomain)) {
    return res.status(400).json({ error: { code: 'INVALID_DOMAIN', message: `"${domain}" is not a valid FQDN`, status: 400 } });
  }
  const safeEmail = String(email || '').trim().toLowerCase();

  const steps = [];
  const push = (step, status, detail) => steps.push({ step, status, detail });

  try {
    const pool = await getServicesPool();        // arion.* schema
    const platformPool = await getPlatformPool(); // core.* schema

    // 1. Find or create tenant (core.tenants is in the platform DB)
    let tenantId;
    const tenantHit = await platformPool.request()
      .input('email', sql.NVarChar(254), safeEmail)
      .input('domain', sql.NVarChar(253), safeDomain)
      .query(`
        SELECT TOP 1 t.tenant_id, t.name, t.full_name
        FROM core.tenants t
        LEFT JOIN core.users u ON u.email = @email
        LEFT JOIN core.tenant_users tu ON tu.user_id = u.user_id AND tu.tenant_id = t.tenant_id
        WHERE t.website_url LIKE '%' + @domain + '%' OR tu.tenant_id IS NOT NULL
      `);
    if (tenantHit.recordset.length > 0) {
      tenantId = tenantHit.recordset[0].tenant_id;
      push('tenant', 'reused', `Found tenant ${tenantHit.recordset[0].full_name || tenantHit.recordset[0].name} (${tenantId})`);
    } else {
      tenantId = crypto.randomUUID();
      // Generate a unique slug — core.tenants.slug is NOT NULL + unique.
      const slug = await generateUniqueSlug(platformPool, name);
      await platformPool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('name', sql.NVarChar(200), name)
        .input('fullName', sql.NVarChar(200), name)
        .input('slug', sql.NVarChar(63), slug)
        .input('status', sql.NVarChar(20), 'active')
        .input('tier', sql.NVarChar(20), tier)
        .input('website', sql.NVarChar(400), `https://${safeDomain}`)
        .query(`
          INSERT INTO core.tenants (tenant_id, name, full_name, slug, status, subscription_tier, website_url)
          VALUES (@tid, @name, @fullName, @slug, @status, @tier, @website)
        `);
      push('tenant', 'created', `Created tenant ${name} (slug=${slug}, ${tenantId})`);
    }

    // 2. Find or create user (core.users is in the platform DB)
    let userId;
    const userHit = await platformPool.request()
      .input('email', sql.NVarChar(254), safeEmail)
      .query('SELECT user_id FROM core.users WHERE email = @email');
    if (userHit.recordset.length > 0) {
      userId = userHit.recordset[0].user_id;
      push('user', 'reused', `Found user ${safeEmail} (${userId})`);
    } else {
      userId = crypto.randomUUID();
      const fullName = (firstName && lastName) ? `${firstName} ${lastName}` : safeEmail;
      await platformPool.request()
        .input('uid', sql.UniqueIdentifier, userId)
        .input('idpId', sql.UniqueIdentifier, IDENTITY_PROVIDER_ID)
        .input('extSub', sql.NVarChar(254), safeEmail)
        .input('email', sql.NVarChar(254), safeEmail)
        .input('firstName', sql.NVarChar(100), firstName)
        .input('lastName', sql.NVarChar(100), lastName)
        .input('fullName', sql.NVarChar(200), fullName)
        .input('status', sql.NVarChar(20), 'active')
        .query(`
          INSERT INTO core.users (user_id, identity_provider_id, external_subject, email, first_name, last_name, full_name, status)
          VALUES (@uid, @idpId, @extSub, @email, @firstName, @lastName, @fullName, @status)
        `);
      push('user', 'created', `Created user ${safeEmail} (${userId})`);
    }

    // 3. Link user → tenant (core.tenant_users in platform DB)
    const linkHit = await platformPool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, userId)
      .query('SELECT 1 AS h FROM core.tenant_users WHERE tenant_id = @tid AND user_id = @uid');
    if (linkHit.recordset.length === 0) {
      await platformPool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('uid', sql.UniqueIdentifier, userId)
        .input('status', sql.NVarChar(20), 'active')
        .query('INSERT INTO core.tenant_users (tenant_id, user_id, status) VALUES (@tid, @uid, @status)');
      push('user_link', 'created', 'Linked user to tenant');
    } else {
      push('user_link', 'reused', 'User already linked to tenant');
    }

    // 4. Enable ARION service (core.tenant_services in platform DB)
    const svcHit = await platformPool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('sid', sql.UniqueIdentifier, ARION_SERVICE_ID)
      .query('SELECT 1 AS h FROM core.tenant_services WHERE tenant_id = @tid AND service_id = @sid');
    if (svcHit.recordset.length === 0) {
      await platformPool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, ARION_SERVICE_ID)
        .input('status', sql.NVarChar(20), 'active')
        .query('INSERT INTO core.tenant_services (tenant_id, service_id, status) VALUES (@tid, @sid, @status)');
      push('service', 'created', 'Enabled ARION service for tenant');
    } else {
      push('service', 'reused', 'ARION service already enabled');
    }

    // 5. Find or create arion.site row (services DB)
    let siteId;
    const siteHit = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('domain', sql.NVarChar(253), safeDomain)
      .query('SELECT site_id FROM arion.site WHERE tenant_id = @tid AND domain = @domain');
    if (siteHit.recordset.length > 0) {
      siteId = siteHit.recordset[0].site_id;
      push('site', 'reused', `Site row already exists (${siteId})`);
    } else {
      siteId = crypto.randomUUID();
      const wpAdminUrlEffective = wpAdminUrl || `https://${safeDomain}/wp-admin/`;
      // Random site token for the IA Plugin's later auth; hashed at rest.
      const rawTokenBytes = new Uint8Array(64);
      crypto.getRandomValues(rawTokenBytes);
      const tokenHash = Array.from(rawTokenBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('domain', sql.NVarChar(253), safeDomain)
        .input('hostingPlan', sql.NVarChar(50), 'managed')
        .input('wpAdminUrl', sql.NVarChar(500), wpAdminUrlEffective)
        .input('status', sql.NVarChar(50), 'active')
        .input('tier', sql.NVarChar(20), tier)
        .input('tokenHash', sql.NVarChar(64), tokenHash.slice(0, 64))
        .input('flagOff', sql.Bit, 0)
        .query(`
          INSERT INTO arion.site
            (site_id, tenant_id, domain, hosting_plan, wp_admin_url, status, arion_tier, site_token_hash,
             site_token_last_rotated, gbp_connected, gsc_connected, google_ads_linked, apple_claimed,
             provisioning_state, provisioned_at, created_at, updated_at)
          VALUES
            (@siteId, @tid, @domain, @hostingPlan, @wpAdminUrl, @status, @tier, @tokenHash,
             SYSDATETIMEOFFSET(), @flagOff, @flagOff, @flagOff, @flagOff,
             'ready', SYSUTCDATETIME(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
        `);
      push('site', 'created', `Created arion.site row (${siteId})`);
    }

    // 6. Issue provisioning code (90-day TTL — gives founder plenty of time
    //    to share the welcome email + customer plenty of time to install)
    const codeRes = await createProvisionCode(pool, {
      tenantId,
      siteId,
      createdBy: 'admin_onboard_existing',
      ttlDays: 90,
    });
    const provisionCode = codeRes.code;
    const pluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(provisionCode)}`;
    push('provision_code', 'created', `Issued 90-day code ${provisionCode.slice(0, 8)}…`);

    // 7. Send welcome email (existing-website variant)
    const setupToken = generateSetupToken();
    let emailResult;
    try {
      emailResult = await sendOnboardingWelcomeEmail({
        toEmail: safeEmail,
        firstName: firstName || '',
        brandName: brandName || name,
        tenantId,
        wpAdminUrl: wpAdminUrl || `https://${safeDomain}/wp-admin/`,
        wpAdminLogin: null,
        wpAdminPassword: null,
        setupToken,
        iaPluginDownloadUrl: pluginDownloadUrl,
        existingWebsite: true,
      });
      push('welcome_email', emailResult.ok ? 'sent' : 'failed', emailResult.ok ? `Sent to ${safeEmail}` : (emailResult.error || 'unknown'));
    } catch (e) {
      push('welcome_email', 'failed', (e.message || '').slice(0, 200));
    }

    return res.json({
      data: {
        tenant_id: tenantId,
        site_id: siteId,
        domain: safeDomain,
        provision_code: provisionCode,
        plugin_download_url: pluginDownloadUrl,
        wp_admin_url: wpAdminUrl || `https://${safeDomain}/wp-admin/`,
        steps,
        handoff: {
          arion: {
            site_url: `https://${safeDomain}/`,
            site_id: siteId,
            plugin_install_link: pluginDownloadUrl,
            activation_email_sent: emailResult?.ok || false,
          },
        },
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[admin/onboard-existing]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500, steps } });
  }
});

/**
 * Generate a unique URL-safe slug for core.tenants.
 * Lowercase, non-alnum → hyphen, dedupe collapse, 3-63 chars.
 * Loops -2/-3/etc on collision until a free slug is found.
 */
async function generateUniqueSlug(pool, name) {
  let base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  if (base.length < 3) base = 'tenant-' + crypto.randomUUID().slice(0, 6);
  let candidate = base;
  let n = 2;
  while (true) {
    const hit = await pool.request()
      .input('slug', sql.NVarChar(63), candidate)
      .query('SELECT 1 AS h FROM core.tenants WHERE slug = @slug');
    if (hit.recordset.length === 0) return candidate;
    candidate = `${base}-${n}`.slice(0, 63);
    n++;
    if (n > 100) return `${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 63);
  }
}

export default router;
