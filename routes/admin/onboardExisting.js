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
import { upsertTenantInvitation } from '../../lib/tenantInvitations.js';
import { installPluginsForTier } from '../../lib/pluginStack.js';
import { stripHostingerOnboardingPlugins, checkWpInstallExists } from '../../lib/hostingerSsh.js';
import { syncSiteTiersFromTenantSubscription } from '../../lib/purchaseTierSync.js';
import { repairDerivedSlug } from '../../lib/reservedSlugs.js';

const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

// Identity provider for our shared CIAM (Entra External ID)
const IDENTITY_PROVIDER_ID = '696CA25F-0011-F111-A69A-00224848050B';

// Per convention_never_hardcode_service_ids: NEVER hardcode service_ids.
// loadServiceIds(pool) queries core.services (platform DB) and returns a
// Map<service_key, service_id>. Result is cached at module scope so we don't
// re-query on every request. Fallback to the historical hardcoded ARION UUID
// only if the lookup fails or the row is missing — safe rollback.
const HARDCODED_FALLBACK_SERVICE_IDS = Object.freeze({
  arion: '44444444-4444-4444-4444-444444444444',
});
let _serviceIdsPromise = null;
async function loadServiceIds(platformPool) {
  if (_serviceIdsPromise) return _serviceIdsPromise;
  _serviceIdsPromise = (async () => {
    try {
      const r = await platformPool.request().query(
        'SELECT service_key, service_id FROM core.services'
      );
      const map = new Map();
      for (const row of r.recordset) {
        if (row.service_key) map.set(String(row.service_key).toLowerCase(), row.service_id);
      }
      return map;
    } catch (err) {
      console.warn('[admin/onboard-existing] loadServiceIds() failed, will use hardcoded fallback:', err.message);
      _serviceIdsPromise = null; // allow retry on next request
      return new Map();
    }
  })();
  return _serviceIdsPromise;
}

const router = Router();

// Exported: routes/admin/siteRequests.js reuses this same gate.
export function requireFounderAuth(req, res, next) {
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

    // 1. Find or create tenant (core.tenants is in the platform DB).
    //
    // 2026-06-27 — Tightened: previously the WHERE clause was
    //   t.website_url LIKE '%' + @domain + '%' OR tu.tenant_id IS NOT NULL
    // which would happily match `intelligentanalyticsdm.com` against
    // `intelligentanalyticsdm.com.evil.com`, AND would attach this
    // onboarding to ANY tenant the email-owner already belonged to, even
    // an unrelated one (e.g. the founder's own tenant). Now: exact
    // host-only match on website_url, and the email→tenant_users path
    // additionally requires that tenant to already own this domain.
    let tenantId;
    const tenantHit = await platformPool.request()
      .input('email', sql.NVarChar(254), safeEmail)
      .input('domain', sql.NVarChar(253), safeDomain)
      .query(`
        SELECT TOP 1 t.tenant_id, t.name, t.full_name
        FROM core.tenants t
        WHERE LOWER(REPLACE(REPLACE(REPLACE(ISNULL(t.website_url, ''), 'https://', ''), 'http://', ''), 'www.', ''))
              IN (@domain, @domain + '/')
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
    // Look up ARION service_id from core.services (cached across requests).
    // Fall back to the historical hardcoded UUID with a warn if the lookup
    // returns nothing — safe rollback per convention_never_hardcode_service_ids.
    const serviceIds = await loadServiceIds(platformPool);
    let ARION_SERVICE_ID = serviceIds.get('arion');
    if (!ARION_SERVICE_ID) {
      ARION_SERVICE_ID = HARDCODED_FALLBACK_SERVICE_IDS.arion;
      console.warn(`[admin/onboard-existing] core.services has no row for service_key='arion' — falling back to hardcoded ${ARION_SERVICE_ID}`);
    }
    const svcHit = await platformPool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('sid', sql.UniqueIdentifier, ARION_SERVICE_ID)
      .query('SELECT 1 AS h FROM core.tenant_services WHERE tenant_id = @tid AND service_id = @sid');
    if (svcHit.recordset.length === 0) {
      await platformPool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('sid', sql.UniqueIdentifier, ARION_SERVICE_ID)
        // 'manual' (migration 041): set up by the founder with no live
        // subscription yet. The entitlement sync never switches it off, and
        // promotes it to 'stripe' once a live subscription covers it.
        .query("INSERT INTO core.tenant_services (tenant_id, service_id, is_enabled, billing_source) VALUES (@tid, @sid, 1, 'manual')");
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

      // Phase B1 (2026-08-22): raise arion_tier / seo_addon_tier from the
      // tenant's Stripe subscription line items, if it has one. Most
      // admin-onboarded tenants have no arion.tenant row / subscription —
      // the sync then returns immediately. Best-effort, never throws.
      const tierSync = await syncSiteTiersFromTenantSubscription(pool, { tenantId, siteId, source: 'onboard_existing' });
      push('tier_sync', tierSync.ok ? (tierSync.updated ? 'updated' : 'skipped') : 'failed',
        tierSync.skipped || tierSync.error || `arion_tier=${tierSync.arionTier || '-'} seo_addon_tier=${tierSync.seoAddonTier || '-'}`);
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

    // 6b. PLUGIN PIPELINE — ROOT CAUSE FIX (2026-06-24).
    //
    // Previously this handler INSERTed the arion.site row with
    // provisioning_state='ready' and went straight to step 7 (welcome email),
    // never calling installPluginsForTier. That meant a migrated Pro-tier site
    // like Rolling In It got the customer's existing plugins (whatever Kodee
    // had left behind) PLUS the IA Plugin via self-install — but NO Elementor
    // Pro, NO Shield Security, NO EWWW config, NO Hostinger-stock-plugin strip,
    // NO SE Ranking crawler whitelist. Diagnostic confirmed elementor-pro and
    // wp-simple-firewall MISSING from rollinginitllc.com despite being Pro tier.
    //
    // Now: pre-flight check WP is reachable over SSH; strip Hostinger's stock
    // onboarding plugins; install the Golden Master stack with onlySlugs
    // limited to the IA-owned/managed plugins (we do NOT re-install the
    // customer's existing plugins). Failures are captured into
    // provisioning_details_json.plugins_installed/plugins_failed/phase_errors
    // and surfaced on the founder dashboard — never silently swallowed.
    //
    // Best-effort: a hard failure here (e.g. site is NOT on the master
    // Hostinger account → no SSH access) leaves the existing customer-self-
    // install fallback in place via the welcome-email plugin link. The
    // provision code already created above remains valid for 90 days.
    let pluginInstallStatus = 'not_attempted';
    let pluginInstallError = null;
    let pluginsInstalledList = [];
    let pluginsFailedList = [];
    const phaseErrors = [];
    try {
      const wpReachable = await checkWpInstallExists(safeDomain);
      if (!wpReachable) {
        pluginInstallStatus = 'ssh_skipped_off_hostinger';
        pluginInstallError = `WP install at ~/domains/${safeDomain}/public_html not reachable via master SSH — likely off-Hostinger or different SSH account. Customer will self-install via welcome email.`;
        push('plugin_pipeline', 'skipped', pluginInstallError);
      } else {
        // 6b.i — Strip Hostinger's stock onboarding plugins. Idempotent and
        // best-effort per-plugin via tryWp() inside the helper.
        try {
          await stripHostingerOnboardingPlugins(safeDomain);
          push('strip_hostinger_plugins', 'ok', 'Removed Hostinger stock onboarding plugins (if present)');
        } catch (stripErr) {
          phaseErrors.push({ phase: 'stripping_hostinger', error: stripErr.message.slice(0, 240) });
          push('strip_hostinger_plugins', 'partial', stripErr.message.slice(0, 200));
        }

        // 6b.ii — Install the IA-owned Golden Master subset. We do NOT touch
        // the customer's existing plugins (no force-install of woocommerce,
        // pdf-embedder, astra-sites, etc.) — only the IA-managed essentials
        // a Pro-tier site MUST have:
        //   - intelligent-analytics (CRITICAL; the whole reason for onboarding)
        //   - hello-elementor theme (required base for Elementor Pro)
        //   - elementor + elementor-pro (Pro-tier promise)
        //   - wp-simple-firewall (Shield) + SE Ranking whitelist (Intelligence reports need this)
        //   - ewww-image-optimizer with IA defaults (perf baseline)
        //   - seo-by-rank-math (only if Kodee didn't already install it)
        //   - litespeed-cache + safe-svg + wp-mail-smtp + advanced-custom-fields
        const stackRes = await installPluginsForTier({
          domain: safeDomain,
          tier,
          installShop: false,
          publishPdfs: false,
          iaPluginDownloadUrl: pluginDownloadUrl,
          provisionCode,
          onlySlugs: [
            'intelligent-analytics',
            'hello-elementor',
            'elementor',
            'elementor-pro',
            'wp-simple-firewall',
            'ewww-image-optimizer',
            'seo-by-rank-math',
            'litespeed-cache',
            'wp-mail-smtp',
            'safe-svg',
            'advanced-custom-fields',
          ],
        });
        pluginsInstalledList = stackRes.installed || [];
        pluginsFailedList = stackRes.failed || [];
        const iaInstalled = pluginsInstalledList.includes('intelligent-analytics')
          || (stackRes.skipped || []).includes('intelligent-analytics');
        const elProInstalled = pluginsInstalledList.includes('elementor-pro')
          || (stackRes.skipped || []).includes('elementor-pro');
        if (!iaInstalled) {
          pluginInstallStatus = 'ia_plugin_missing_email_fallback';
          pluginInstallError = `IA Plugin did not install via SSH (installed=[${pluginsInstalledList.join(',')}], failed=${JSON.stringify(pluginsFailedList).slice(0, 200)})`;
          phaseErrors.push({ phase: 'installing_plugins', error: pluginInstallError });
        } else if (!elProInstalled && tier === 'pro') {
          // Pro-tier promise: Elementor Pro MUST land. If not, mark partial
          // so the dashboard surfaces a "fix this" affordance.
          pluginInstallStatus = 'ssh_partial_no_elementor_pro';
          pluginInstallError = `Elementor Pro did not install (failed=${JSON.stringify(pluginsFailedList).slice(0, 240)})`;
          phaseErrors.push({ phase: 'installing_plugins', error: pluginInstallError });
        } else if (pluginsFailedList.length > 0) {
          pluginInstallStatus = 'ssh_partial';
          pluginInstallError = `Partial failures: ${JSON.stringify(pluginsFailedList).slice(0, 280)}`;
          phaseErrors.push({ phase: 'installing_plugins_post_hooks', error: pluginInstallError });
        } else {
          pluginInstallStatus = 'ssh_success';
        }
        push(
          'plugin_pipeline',
          pluginInstallStatus,
          `installed=[${pluginsInstalledList.join(',')}], skipped=[${(stackRes.skipped || []).join(',')}], failed=${pluginsFailedList.length}`,
        );
      }
    } catch (pipelineErr) {
      pluginInstallStatus = 'ssh_failed_email_fallback';
      pluginInstallError = (pipelineErr.message || '').slice(0, 300);
      phaseErrors.push({ phase: 'installing_plugins', error: pluginInstallError });
      push('plugin_pipeline', 'failed', pluginInstallError);
      console.warn(`[admin/onboard-existing] plugin pipeline failed (will rely on welcome-email fallback): ${pluginInstallError}`);
    }

    // 7. Send welcome email (existing-website variant)
    const setupToken = generateSetupToken();
    // F-SEC1.3: persist SHA-256 hash of the setupToken on arion.site so the
    // /onboarding/activate endpoint can verify the inbound plaintext token
    // (it hashes the inbound token and timing-safe-compares against this).
    // Plaintext setupToken only lives in the welcome email URL below.
    const setupTokenHash = (await import('node:crypto'))
      .createHash('sha256').update(setupToken).digest('hex');
    // 2026-06-27 — Brandon-directed 48h TTL (down from 72h). The expired-token
    // resend-verification flow at /onboarding/activate handles users who miss
    // the window — see `routes/onboarding/activate.js`.
    const setupTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    try {
      const existingDetailsRes = await pool.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query('SELECT provisioning_details_json FROM arion.site WHERE site_id = @siteId');
      let detailsObj = {};
      const rawDetails = existingDetailsRes.recordset[0]?.provisioning_details_json;
      if (rawDetails) {
        try { detailsObj = JSON.parse(rawDetails) || {}; } catch (_) { detailsObj = {}; }
      }
      detailsObj.flow = detailsObj.flow || 'existing_website_admin_onboard';
      detailsObj.provision_code = provisionCode;
      detailsObj.tier = tier;
      detailsObj.ia_plugin_download_url = pluginDownloadUrl;
      detailsObj.welcome_token = setupTokenHash;
      detailsObj.welcome_token_expires_at = setupTokenExpiresAt;
      detailsObj.welcome_token_used_at = null;
      // 2026-06-24 — Persist plugin-pipeline outcomes so the founder dashboard
      // can show "plugins_failed=[]" / "Pro-stack landed" affordances instead
      // of a green checkmark over a broken Pro-tier install.
      detailsObj.plugin_install_status = pluginInstallStatus;
      detailsObj.plugin_install_error = pluginInstallError;
      detailsObj.plugins_installed = pluginsInstalledList;
      detailsObj.plugins_failed = pluginsFailedList;
      detailsObj.phase_errors = phaseErrors;
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(detailsObj))
        .query(`
          UPDATE arion.site
          SET provisioning_details_json = @details,
              updated_at = SYSDATETIMEOFFSET()
          WHERE site_id = @siteId
        `);
      push('welcome_token', 'persisted', `Hashed setup token + 72h expiry stored on site ${siteId}`);
    } catch (tokenErr) {
      push('welcome_token', 'failed', (tokenErr.message || '').slice(0, 200));
      console.error('[admin/onboard-existing] persist welcome_token failed:', tokenErr);
    }
    // 2026-06-27 — C.01: insert/refresh the core.tenant_invitations row so
    // platform-api/session/verify.js auto-claims this customer into their
    // tenant on first CIAM verify.
    try {
      await upsertTenantInvitation(platformPool, {
        tenantId,
        email: safeEmail,
        roleKey: 'owner',
      });
      push('tenant_invitation', 'upserted', `pending invitation for ${safeEmail}`);
    } catch (invErr) {
      console.error('[admin/onboard-existing] tenant_invitations upsert failed:', invErr?.message);
      push('tenant_invitation', 'failed', (invErr?.message || '').slice(0, 200));
    }

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
  // D-38 — the first path segment on customer.ia-dm.com / crew.ia-dm.com /
  // book.ia-dm.com names the BUSINESS, and some segments are not businesses
  // (`p`, `unsubscribe`, `present`, `confirm`, `cancel`, the static asset
  // directories). A business minted with one of those as its slug is
  // unreachable: its customers land on a public token route instead. Nothing
  // checked that here, and arion mints tenants from two paths.
  //
  // This slug is DERIVED from a business name, never typed by a caller, so it
  // is REPAIRED rather than refused — failing an onboarding over a word the
  // client has never heard of is the worse outcome, and the suffix is the same
  // shape the collision loop below already produces. The list is shared,
  // byte-for-byte, with oliver-api and the three apps.
  let base = repairDerivedSlug(
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56),
    crypto.randomUUID().slice(0, 6),
  );
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
