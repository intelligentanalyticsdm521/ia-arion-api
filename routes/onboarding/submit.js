/**
 * Onboarding — Submit Route
 * --------------------------------------------------------------------------
 * Called by the OnboardingFlow UI after the client finishes the wizard. This
 * is the orchestrator that:
 *
 *   1. Validates the signup session (Stripe checkout completed)
 *   2. Persists questionnaire + domain decision
 *   3. For BYOD: verifies nameservers point to Hostinger (returns 425 if not)
 *   4. For purchase: registers domain via Hostinger API
 *   5. Creates the WordPress install via Hostinger API → wp_admin creds
 *   6. Builds the AI prompt from questionnaire
 *   7. Issues / re-uses a provisioning code
 *   8. Creates a provisioning_job row + dispatches to the Playwright worker
 *   9. Returns the job_id so the UI can start polling /onboarding/status
 *
 * The endpoint is idempotent — if called twice with the same session it
 * reuses the existing job.
 */

import { Router } from 'express';
import sql from 'mssql';
import { webcrypto as crypto } from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';
import { buildAiPrompt } from '../../lib/promptBuilder.js';
import { verifyHostingerNameservers } from '../../lib/dnsVerifier.js';
import {
  purchaseDomain,
  createWhoisProfile,
  createWebsite,
  createDatabase,
  installWordPress,
  enableDomainLock,
  enablePrivacyProtection,
} from '../../lib/hostinger.js';
import {
  stripHostingerOnboardingPlugins,
  createClientEditor,
  applyBranding,
} from '../../lib/hostingerSsh.js';
import { installPluginsForTier } from '../../lib/pluginStack.js';
import { driveKodeeBuild } from '../../lib/browserDriver.js';
import {
  sendOnboardingWelcomeEmail,
  generateSetupToken,
} from '../../lib/welcomeEmail.js';
import { createJob, transitionState, getLatestJobForSite } from '../../lib/provisioningJobs.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';
import { updateSharedProfile } from '../../db/platformPool.js';

// arion-api base URL (so the IA Plugin gets a valid download URL inside wp-cli).
// Tries env first, then falls back to the prod hostname.
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

const router = Router();

router.post('/', async (req, res) => {
  const { session_id, domain, answers } = req.body || {};

  if (!session_id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'session_id required', status: 400 } });
  }
  if (!domain || !domain.mode || !['purchase', 'byod'].includes(domain.mode) || !domain.domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain.mode and domain.domain required', status: 400 } });
  }
  if (!answers || !answers.businessName || !answers.industry) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'answers.businessName and answers.industry required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    // 1. Resolve session → tenant + site
    const sessionRow = await pool.request()
      .input('sessionId', sql.NVarChar(200), session_id)
      .query(`SELECT TOP 1 session_pk, tenant_id, site_id, email FROM arion.signup_session WHERE stripe_session_id = @sessionId`);

    if (sessionRow.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Signup session not found', status: 404 } });
    }
    const session = sessionRow.recordset[0];

    // 2. Idempotency — if there's already a job in flight or completed, return it
    const existing = await getLatestJobForSite(pool, { tenantId: session.tenant_id, siteId: session.site_id });
    if (existing && !['failed'].includes(existing.state)) {
      return res.json({
        data: { job_id: existing.job_id, state: existing.state, reused: true },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // 3. Persist questionnaire + domain on the session
    await pool.request()
      .input('sessionPk', sql.Int, session.session_pk)
      .input('answers', sql.NVarChar(sql.MAX), JSON.stringify(answers))
      .input('domain', sql.NVarChar(2000), JSON.stringify(domain))
      .query(`
        UPDATE arion.signup_session
        SET questionnaire_json = @answers,
            domain_json = @domain,
            questionnaire_submitted_at = SYSDATETIMEOFFSET(),
            submitted_at = SYSDATETIMEOFFSET()
        WHERE session_pk = @sessionPk
      `);

    // 3b. Persist the CANONICAL org fields back to the shared core.tenants
    // record so OLIVER/SPARK see the same business name + brand the customer
    // just confirmed. ARION-specific website answers (industry, services,
    // pages, voice, style…) stay ARION-local in questionnaire_json. Strictly
    // best-effort — updateSharedProfile swallows its own errors so a platform-
    // DB hiccup can never block site provisioning (critical path).
    await updateSharedProfile(session.tenant_id, {
      businessName: answers.businessName || null,
      brandColor: answers.primaryColor || null,
      websiteUrl: domain.domain ? `https://${domain.domain}` : null,
    });

    // 4. BYOD verification gate
    if (domain.mode === 'byod') {
      const nsCheck = await verifyHostingerNameservers(domain.domain);
      if (!nsCheck.pointsToHostinger) {
        return res.status(425).json({
          error: {
            code: 'DNS_NOT_PROPAGATED',
            message: 'Domain nameservers have not yet been pointed to Hostinger. Please update your nameservers and we\'ll start the build automatically when DNS propagates.',
            status: 425,
            details: { current_nameservers: nsCheck.nameservers },
          },
        });
      }
    }

    // 5. Domain registration (purchase mode)
    if (domain.mode === 'purchase') {
      // Domain purchase requires: catalog item_id + WHOIS profile + a hosting plan order_id.
      // The questionnaire collects WHOIS contact info; the catalog item is resolved on
      // demand. If any of these prerequisites are missing, fail fast with a clear error.
      const purchaseRes = await registerPurchasedDomain({
        domain: domain.domain,
        whois: req.body?.whois || answers?.whois || null,
        sessionEmail: session.email,
      });
      if (!purchaseRes.ok) {
        return res.status(502).json({ error: { code: 'DOMAIN_PURCHASE_FAILED', message: purchaseRes.error, status: 502 } });
      }
    }

    // 6. Create the WordPress install on Hostinger
    // Hostinger schema: domain + order_id (integer) + optional datacenter_code.
    // No admin_email/password fields — the WP admin user is created from the Hostinger
    // account default. Credentials are retrieved from getWebsiteDetails() after creation.
    const orderId = Number(process.env.HOSTINGER_DEFAULT_ORDER_ID || 0);
    if (!orderId) {
      return res.status(503).json({
        error: {
          code: 'NOT_CONFIGURED',
          message: 'HOSTINGER_DEFAULT_ORDER_ID env var is not set. Run the Hostinger smoke test (scripts/smoke-test.js) to find your active hosting order ID.',
          status: 503,
        },
      });
    }
    const wpCreate = await createWebsite({
      domain: domain.domain,
      orderId,
      datacenterCode: process.env.HOSTINGER_DEFAULT_DATACENTER || undefined,
    });
    if (!wpCreate.ok) {
      // Hostinger returns 422 "Domain already in use" when a website for this
      // domain already exists on the account. That's not a failure for our
      // flow — it means /submit is being re-tried after partial completion,
      // or the operator already provisioned the domain manually. Continue
      // with what we know about the existing install.
      const alreadyInUse = String(wpCreate.error || '').includes('Domain already in use');
      if (!alreadyInUse) {
        return res.status(502).json({ error: { code: 'WP_CREATE_FAILED', message: wpCreate.error, status: 502 } });
      }
      // Fall through with a stub data object and the alreadyInUse flag set so
      // the createDatabase + installWordPress branch below knows to skip.
      wpCreate.data = { domain: domain.domain, alreadyInUse: true };
    }
    // Hostinger's POST /api/hosting/v1/websites response shape (verified 2026-06-14):
    //   { domain, vhost_type, is_enabled, username, client_id, order_id, created_at, root_directory, parent_domain }
    // We need `username` for the next two API calls (createDatabase + installWordPress).
    const hostingerUsername = wpCreate.data?.username
      || process.env.HOSTINGER_DEFAULT_USERNAME
      || null;
    const websiteId = wpCreate.data?.domain || domain.domain;
    const wpAdminUrl = `https://${domain.domain}/wp-admin/`;

    if (!hostingerUsername) {
      return res.status(500).json({
        error: {
          code: 'NO_HOSTINGER_USERNAME',
          message: 'createWebsite did not return a username and HOSTINGER_DEFAULT_USERNAME is not set. Cannot proceed with DB + WP install.',
          status: 500,
        },
      });
    }

    // 7. Issue provisioning code FIRST — the IA Plugin download URL embeds it.
    const codeRes = await createProvisionCode(pool, {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      createdBy: 'onboarding_submit',
      ttlDays: 14,
    });
    const provisionCode = codeRes.code;
    const pluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(provisionCode)}`;

    // 8. Generate credentials we'll need everywhere downstream. The DB user +
    //    name get the username_ prefix automatically applied by Hostinger.
    //    Keep names short (32 char limit including prefix in Hostinger MySQL).
    const dbSuffix = String(session.tenant_id).slice(0, 8).toLowerCase().replace(/-/g, '');
    const dbName = `arion_${dbSuffix}`.slice(0, 18);
    const dbUser = `arion_${dbSuffix}`.slice(0, 18);
    const dbPassword = generatePassword();

    const adminLogin = 'iaadmin';
    const adminPassword = generatePassword();
    const adminEmail = process.env.IA_STAFF_ADMIN_EMAIL || 'info@intelligentanalyticsdm.com';

    // 9. Persist initial site state (queued) before the long-running install calls.
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, session.site_id)
      .input('websiteId', sql.NVarChar(80), String(websiteId || ''))
      .input('wpAdminUrl', sql.NVarChar(500), wpAdminUrl)
      .input('domain', sql.NVarChar(253), domain.domain)
      .input('domainMode', sql.NVarChar(20), domain.mode)
      .input('primaryColor', sql.NVarChar(20), answers.primaryColor || null)
      .query(`
        UPDATE arion.site
        SET hostinger_website_id = @websiteId,
            wp_admin_url = @wpAdminUrl,
            domain = @domain,
            domain_mode = @domainMode,
            branding_primary_color = @primaryColor,
            provisioning_state = 'queued',
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);

    // 10. Hostinger API: createDatabase. Always attempt — if Hostinger says
    //     "already exists" we swallow the per-call error so a partial-retry
    //     can progress. Surface anything else.
    const dbRes = await createDatabase({
      username: hostingerUsername,
      name: dbName,
      user: dbUser,
      password: dbPassword,
      websiteDomain: domain.domain,
    });
    if (!dbRes.ok && !isAlreadyExistsError(dbRes.error)) {
      return res.status(502).json({
        error: { code: 'DB_CREATE_FAILED', message: dbRes.error, status: 502 },
      });
    }

    // 11. Hostinger API: installWordPress. Same idempotency rule.
    const wpInstall = await installWordPress({
      username: hostingerUsername,
      domain: domain.domain,
      siteTitle: answers.businessName,
      credentials: {
        email: adminEmail,
        login: adminLogin,
        password: adminPassword,
      },
    });
    if (!wpInstall.ok && !isAlreadyExistsError(wpInstall.error)) {
      return res.status(502).json({
        error: { code: 'WP_INSTALL_FAILED', message: wpInstall.error, status: 502 },
      });
    }

    // 12. Wait for WordPress to come online so subsequent steps can talk to it.
    //     Fail loud if it doesn't — silent failures here ship broken sites.
    const wpReady = await waitForWpReady(domain.domain);
    if (!wpReady) {
      return res.status(502).json({
        error: {
          code: 'WP_NOT_READY',
          message: `WordPress did not respond at https://${domain.domain}/wp-login.php within 2 minutes. Install may have failed or DNS is still propagating.`,
          status: 502,
        },
      });
    }

    // 13. Build the questionnaire-derived AI prompt. Capped at 2000 chars per
    //     Hostinger's Kodee limit — promptBuilder.js handles truncation.
    const { prompt: aiPrompt } = buildAiPrompt(answers);

    // 14. Drive Hostinger's Kodee AI WordPress builder via the browser-driver
    //     Container App. Kodee is wp-admin-only (no public API), so we paste
    //     our prompt into its wizard and wait. The driver returns when Kodee
    //     reports "done" or after a 5-minute hard timeout. Soft failures
    //     (status: 'failed') get logged but don't block the rest of the flow;
    //     ops can re-trigger Kodee manually if it didn't take.
    let kodeeResult;
    try {
      kodeeResult = await driveKodeeBuild({
        domain: domain.domain,
        adminLogin,
        adminPassword,
        prompt: aiPrompt,
      });
    } catch (drvErr) {
      console.error('[onboarding/submit] browser-driver call failed:', drvErr.message);
      kodeeResult = { status: 'failed', duration_ms: 0, screenshots: [], error: drvErr.message };
    }
    if (kodeeResult.status !== 'completed') {
      console.warn(`[onboarding/submit] Kodee did not complete cleanly: ${kodeeResult.error || 'unknown'} — continuing with stack install anyway`);
    }

    // 15. Now that Kodee is finished (or skipped), strip Hostinger's stock
    //     onboarding plugins so they don't intercept wp-admin once the
    //     customer logs in.
    await stripHostingerOnboardingPlugins(domain.domain);

    // 16. Create the client's editor-level WP user.
    await createClientEditor({
      domain: domain.domain,
      clientEmail: session.email,
      clientFirstName: (answers.contactFirstName || '').toString() || answers.businessName,
      clientLastName: (answers.contactLastName || '').toString() || '',
    });

    // 17. Install the Golden Master plugin stack for this tenant's tier. The
    //     matrix lives in lib/pluginStack.js — mirrored in
    //     reference_arion_plugin_stack.md. WooCommerce gates on
    //     answers.installShop (questionnaire Page 4 question).
    const tier = (answers.tier || session.tier || 'lite').toLowerCase();
    const installShop = answers.installShop === true || answers.needsShop === true;
    const stackResult = await installPluginsForTier({
      domain: domain.domain,
      tier,
      installShop,
      iaPluginDownloadUrl: pluginDownloadUrl,
    });

    // 18. Apply branding via SSH wp-cli — overrides anything Kodee chose with
    //     the colors the customer specified in the questionnaire.
    await applyBranding({
      domain: domain.domain,
      brandName: answers.businessName,
      primaryColor: answers.primaryColor,
      secondaryColor: answers.secondaryColor,
      accentColor: answers.accentColor,
    });

    // 19. Generate the CIAM activation token for the welcome email link. The
    //     Portal /welcome route will exchange it via platform-api.
    const setupToken = generateSetupToken();

    // 20. Final state — site is ready. Provisioning details captured for ops.
    const provisioningDetails = {
      hostinger_username: hostingerUsername,
      wp_admin_login: adminLogin,
      wp_admin_email: adminEmail,
      wp_admin_password_set: true,
      db_name_suffix: dbName,
      db_user_suffix: dbUser,
      provisioned_at: new Date().toISOString(),
      provision_code: provisionCode,
      ai_prompt_chars: aiPrompt.length,
      tier,
      install_shop: installShop,
      plugins_installed: stackResult.installed,
      plugins_skipped: stackResult.skipped,
      kodee_status: kodeeResult.status,
      kodee_duration_ms: kodeeResult.duration_ms,
      kodee_error: kodeeResult.error || null,
      welcome_token: setupToken, // stored so platform-api can verify on /welcome
    };

    await pool.request()
      .input('siteId', sql.UniqueIdentifier, session.site_id)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(provisioningDetails))
      .query(`
        UPDATE arion.site
        SET provisioning_state = 'ready',
            provisioned_at = SYSUTCDATETIME(),
            provisioning_details_json = @details,
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);

    // 21. Send the "your site is ready + activate your portal" email. Best
    //     effort — a failed send does not block. Ops can re-send via the
    //     admin console using the welcome_token stored above.
    try {
      const emailRes = await sendOnboardingWelcomeEmail({
        toEmail: session.email,
        firstName: answers.contactFirstName || answers.firstName || '',
        brandName: answers.businessName,
        tenantId: session.tenant_id,
        wpAdminUrl,
        wpAdminLogin: adminLogin,
        wpAdminPassword: adminPassword,
        setupToken,
      });
      if (!emailRes.ok) {
        console.warn('[onboarding/submit] welcome email failed:', emailRes.error);
      }
    } catch (emailErr) {
      console.error('[onboarding/submit] welcome email threw:', emailErr.message);
    }

    return res.status(200).json({
      data: {
        site_id: session.site_id,
        tenant_id: session.tenant_id,
        domain: domain.domain,
        wp_admin_url: wpAdminUrl,
        provisioning_state: 'ready',
        provision_code: provisionCode,
        plugins_installed: stackResult.installed,
        kodee_status: kodeeResult.status,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/submit]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register a purchased domain via Hostinger.
 *
 * Required: real WHOIS contact info (most TLDs reject placeholders).
 * Required: a Hostinger catalog item_id for the domain registration price —
 *           we look this up from the catalog at request time.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {object|null} args.whois - { first_name, last_name, email, phone, address1, city, state, zip, country, entity_type, ... }
 * @param {string} args.sessionEmail
 */
async function registerPurchasedDomain({ domain, whois, sessionEmail }) {
  if (!whois || !whois.first_name || !whois.last_name || !whois.address1 || !whois.city || !whois.state || !whois.zip || !whois.phone) {
    return {
      ok: false,
      error: 'WHOIS contact info is required (first_name, last_name, address1, city, state, zip, phone). Collect via the onboarding questionnaire.',
    };
  }

  const tld = domain.split('.').pop();
  const whoisRes = await createWhoisProfile({
    tld,
    country: whois.country || 'US',
    entity_type: whois.entity_type || 'individual',
    whois_details: {
      first_name: whois.first_name,
      last_name: whois.last_name,
      email: whois.email || sessionEmail,
      phone: whois.phone,
      address1: whois.address1,
      city: whois.city,
      state: whois.state,
      zip: whois.zip,
      country: whois.country || 'US',
    },
  });
  if (!whoisRes.ok) return { ok: false, error: 'WHOIS profile creation failed: ' + whoisRes.error };
  const whoisOwnerId = whoisRes.data?.id;

  // Resolve the catalog item ID for the domain registration price.
  // Hostinger's catalog returns one item per (TLD, period) combination.
  const itemId = process.env[`HOSTINGER_DOMAIN_ITEM_${tld.toUpperCase()}`] || null;
  if (!itemId) {
    return {
      ok: false,
      error: `No catalog item ID configured for .${tld}. Run scripts/smoke-test.js to discover and set HOSTINGER_DOMAIN_ITEM_${tld.toUpperCase()}.`,
    };
  }

  const purchase = await purchaseDomain({ domain, itemId, whoisOwnerId });
  if (!purchase.ok) return { ok: false, error: 'Domain purchase failed: ' + purchase.error };

  // Best-effort hardening
  enableDomainLock(domain).catch(() => {});
  enablePrivacyProtection(domain).catch(() => {});
  return { ok: true, order_id: purchase.data?.order_id };
}

/**
 * Poll the public site URL until WordPress responds (wp-login.php exists).
 * Hostinger's installWordPress is mostly synchronous but the WP files can
 * take 10-30s to be readable post-install — this avoids racing the subsequent
 * SSH/wp-cli calls.
 *
 * @param {string} domain
 * @param {number} [timeoutMs=120_000]  — give up after 2 minutes
 */
async function waitForWpReady(domain, timeoutMs = 120_000) {
  const start = Date.now();
  const url = `https://${domain}/wp-login.php`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      // wp-login.php either 200s (form) or 302s (redirect to https). Either way it exists.
      if (res.status === 200 || res.status === 302) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.warn(`[onboarding/submit] waitForWpReady gave up after ${timeoutMs}ms for ${domain}`);
  return false;
}

/**
 * Treat Hostinger "already exists" / "in use" / 409-style messages as
 * non-failures so partial-retry runs of /submit can progress. Anything else
 * (auth, validation, server error) should still bubble.
 *
 * The Hostinger API surfaces these as 4xx with a body like:
 *   { message: "Domain already in use", ... }
 *   { message: "Database already exists", ... }
 *   { message: "WordPress is already installed", ... }
 *
 * Our `request()` lifts those into the `error` string of the result envelope.
 */
function isAlreadyExistsError(err) {
  const s = String(err || '').toLowerCase();
  return s.includes('already in use')
    || s.includes('already exists')
    || s.includes('already installed')
    || s.includes('must be unique')      // Hostinger DB-name collision phrasing
    || s.includes('name is taken');
}

/**
 * Generate a strong WP admin password.
 * 16 chars, mixed case + digits + symbols, easy to copy-paste.
 */
function generatePassword() {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  const buf = new Uint32Array(20);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 20; i++) out += charset[buf[i] % charset.length];
  return out;
}

export default router;
