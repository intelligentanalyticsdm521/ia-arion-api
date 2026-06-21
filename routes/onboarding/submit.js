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
  ensureAdminPassword,
  applyBranding,
  runWpCli,
} from '../../lib/hostingerSsh.js';
import { installPluginsForTier } from '../../lib/pluginStack.js';
import { generateSiteCopy } from '../../lib/aiCopy.js';
import { setElementorGlobals } from '../../lib/elementorGlobals.js';
import { generateSiteImages } from '../../lib/imageGen.js';
import {
  generateAllPages,
  postElementorPage,
  setStaticFrontPage,
} from '../../lib/websiteBuilder/onboardingDriver.js';
import {
  sendOnboardingWelcomeEmail,
  generateSetupToken,
} from '../../lib/welcomeEmail.js';
import { createJob, transitionState, getLatestJobForSite } from '../../lib/provisioningJobs.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';
import { updateSharedProfile } from '../../db/platformPool.js';
import { updatePhase, markFailed } from '../../lib/provisioningPhase.js';

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
  // R2 — FQDN validation: catch junk before we hit Hostinger and get a vague error
  if (!isValidFqdn(domain.domain)) {
    return res.status(400).json({ error: {
      code: 'INVALID_DOMAIN',
      message: `"${domain.domain}" is not a valid domain name (expected something like example.com or sub.example.com).`,
      status: 400,
    }});
  }
  // R2 — Business name validation
  const businessName = String(answers?.businessName || '').trim();
  if (!businessName || businessName.length < 2) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Business name must be at least 2 characters', status: 400 } });
  }
  if (!answers || !answers.industry) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'answers.industry required', status: 400 } });
  }
  // Normalize the trimmed business name back into the answers payload
  answers.businessName = businessName;

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

    // 4. BYOD verification gate. R2 — when nameservers are not yet propagated,
    //    kick off a background poller that re-runs the orchestrator as soon as
    //    DNS lands. Customer's UI sees `dns_verifying` phase in the meantime.
    if (domain.mode === 'byod') {
      const nsCheck = await verifyHostingerNameservers(domain.domain);
      if (!nsCheck.pointsToHostinger) {
        await updatePhase(pool, session.site_id, 'dns_verifying');
        // Fire-and-forget — wait up to 30 min for NS to propagate, then
        // re-invoke this same POST internally so the customer doesn't have
        // to manually resubmit.
        setImmediate(() => waitForDnsAndResubmit({
          domain: domain.domain,
          sessionId: session_id,
          body: req.body,
          pool,
          siteId: session.site_id,
        }).catch((e) => console.error('[onboarding/submit] dns-resume failed:', e.message)));
        return res.status(425).json({
          error: {
            code: 'DNS_NOT_PROPAGATED',
            message: 'Domain nameservers have not yet been pointed to Hostinger. We\'ll automatically start the build when DNS propagates (up to 30 minutes).',
            status: 425,
            details: { current_nameservers: nsCheck.nameservers, auto_retry: true },
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

    // 5b. Domain-claim check — make sure no other tenant already owns this
    //     domain in our system. Prevents two customers from both trying to
    //     provision the same domain simultaneously (or sequentially).
    {
      const claimCheck = await pool.request()
        .input('domain', sql.NVarChar(253), domain.domain)
        .input('tenantId', sql.UniqueIdentifier, session.tenant_id)
        .query(`
          SELECT TOP 1 tenant_id, site_id
          FROM arion.site
          WHERE domain = @domain AND tenant_id <> @tenantId
        `);
      if (claimCheck.recordset.length > 0) {
        return res.status(409).json({ error: {
          code: 'DOMAIN_ALREADY_CLAIMED',
          message: 'This domain is already registered to another account. Please contact support if you believe this is in error.',
          status: 409,
        }});
      }
    }

    // 5c. Existing-website branch — customer says they have a working WP at
    //     this domain. We do NOT create a Hostinger website slot, do NOT
    //     install WP, do NOT import a template, do NOT splice copy. We only
    //     install the IA Plugin via SSH (if site is on Hostinger), set brand
    //     options, and send the welcome email with the plugin download URL
    //     so off-Hostinger customers can install it themselves.
    const hasExistingWebsite = answers.hasExistingWebsite === true;

    let hostingerUsername = null;
    let websiteId = domain.domain;
    const wpAdminUrl = `https://${domain.domain}/wp-admin/`;

    if (!hasExistingWebsite) {
      // 6. Create the WordPress install on Hostinger via REST API.
      const orderId = Number(process.env.HOSTINGER_DEFAULT_ORDER_ID || 0);
      if (!orderId) {
        return res.status(503).json({
          error: {
            code: 'NOT_CONFIGURED',
            message: 'HOSTINGER_DEFAULT_ORDER_ID env var is not set.',
            status: 503,
          },
        });
      }
      await updatePhase(pool, session.site_id, 'creating_hosting');
      const wpCreate = await createWebsite({
        domain: domain.domain,
        orderId,
        datacenterCode: process.env.HOSTINGER_DEFAULT_DATACENTER || undefined,
      });
      if (!wpCreate.ok) {
        const alreadyInUse = String(wpCreate.error || '').includes('Domain already in use');
        if (!alreadyInUse) {
          return res.status(502).json({ error: { code: 'WP_CREATE_FAILED', message: wpCreate.error, status: 502 } });
        }
        wpCreate.data = { domain: domain.domain, alreadyInUse: true };
      }
      hostingerUsername = wpCreate.data?.username
        || process.env.HOSTINGER_DEFAULT_USERNAME
        || null;
      websiteId = wpCreate.data?.domain || domain.domain;
      if (!hostingerUsername) {
        return res.status(500).json({
          error: {
            code: 'NO_HOSTINGER_USERNAME',
            message: 'createWebsite did not return a username and HOSTINGER_DEFAULT_USERNAME is not set.',
            status: 500,
          },
        });
      }
    } else {
      // Existing WP — try to use the master Hostinger username (may not be
      // applicable if the customer's site is NOT on Hostinger). If SSH is
      // unreachable downstream, the orchestrator will fall back to email-only
      // delivery: customer installs the IA Plugin from the welcome email
      // download link and the plugin self-registers on activation.
      hostingerUsername = process.env.HOSTINGER_DEFAULT_USERNAME || null;
    }

    // 7. Persist initial site state
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
    await updatePhase(pool, session.site_id, 'queued');

    // === ASYNC HANDOFF ===
    res.status(202).json({
      data: {
        site_id: session.site_id,
        tenant_id: session.tenant_id,
        domain: domain.domain,
        wp_admin_url: wpAdminUrl,
        provisioning_state: 'queued',
        status_url: `/onboarding/status?session_id=${encodeURIComponent(session_id)}`,
        estimated_seconds: 900,
      },
      meta: { timestamp: new Date().toISOString() },
    });

    setImmediate(async () => {
      try {
        await runProvisioningBackground({
          pool, session, domain, answers, hostingerUsername, wpAdminUrl,
        });
      } catch (err) {
        console.error('[onboarding/submit/background]', err);
        try { await markFailed(pool, session.site_id, err); } catch { /* noop */ }
      }
    });
    return;
  } catch (err) {
    console.error('[onboarding/submit]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/**
 * Long-running orchestration body. Each step updates the provisioning phase
 * on arion.site so the status endpoint can drive a progress bar.
 */
async function runProvisioningBackground({ pool, session, domain, answers, hostingerUsername, wpAdminUrl }) {
    const hasExistingWebsite = answers.hasExistingWebsite === true;

    // R3 — Provisioning path telemetry. Makes debugging much easier — one log
    // line tells you exactly which combo of {NEW/EXISTING customer, BUY/BYOD
    // domain, NEW/EXISTING WordPress} this run was.
    const provisioningPath = `byod=${domain.mode === 'byod'} existing_wp=${hasExistingWebsite}`;
    console.log(`[onboarding/submit] provisioning ${session.tenant_id}/${session.site_id} domain=${domain.domain} ${provisioningPath}`);

    // 7. Issue provisioning code FIRST — the IA Plugin download URL embeds it.
    const codeRes = await createProvisionCode(pool, {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      createdBy: 'onboarding_submit',
      ttlDays: hasExistingWebsite ? 90 : 14,  // longer TTL for self-install
    });
    const provisionCode = codeRes.code;
    const pluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(provisionCode)}`;
    const adminLogin = 'iaadmin';
    const adminPassword = generatePassword();
    const adminEmail = process.env.IA_STAFF_ADMIN_EMAIL || 'info@intelligentanalyticsdm.com';

    // ============================================================
    // EXISTING WORDPRESS BRANCH (paths #2/#4/#6/#8)
    // ============================================================
    // Customer has a working WP at this domain. DO NOT provision a slot, DO
    // NOT import a template, DO NOT splice copy. Try SSH-install the IA Plugin
    // (works when site is on Hostinger). If SSH fails, the welcome email gives
    // the customer a download link and they install it manually — plugin
    // self-registers with ARION on activation.
    if (hasExistingWebsite) {
      const tier = (answers.tier || session.tier || 'lite').toLowerCase();
      let pluginInstallStatus = 'not_attempted';
      let pluginInstallError = null;
      try {
        await updatePhase(pool, session.site_id, 'installing_plugins');
        // Try to install the IA Plugin via SSH. This only works if the site
        // is on our master Hostinger account.
        const { installPluginsForTier: installFn } = await import('../../lib/pluginStack.js');
        const stackRes = await installFn({
          domain: domain.domain,
          tier,
          installShop: false,
          iaPluginDownloadUrl: pluginDownloadUrl,
          provisionCode,
          // For existing-site we only install IA Plugin, NOT the full Golden
          // Master — the customer's existing plugins are theirs to manage.
          onlySlugs: ['intelligent-analytics'],
        });
        pluginInstallStatus = 'ssh_success';
      } catch (sshErr) {
        // Site likely off-Hostinger or SSH unreachable — fall back to email-only.
        pluginInstallStatus = 'ssh_failed_email_fallback';
        pluginInstallError = (sshErr.message || '').slice(0, 300);
        console.warn(`[onboarding/submit] existing-WP SSH install failed (will email): ${pluginInstallError}`);
      }

      // Set brand colors on the IA plugin options (only works if plugin installed)
      try {
        await updatePhase(pool, session.site_id, 'applying_branding');
        await applyBranding({
          domain: domain.domain,
          brandName: answers.businessName,
          primaryColor: answers.primaryColor,
          secondaryColor: answers.secondaryColor,
          accentColor: answers.accentColor,
        });
      } catch (e) {
        console.warn(`[onboarding/submit] existing-WP applyBranding skipped: ${e.message.slice(0, 200)}`);
      }

      await updatePhase(pool, session.site_id, 'finishing_up');
      const setupToken = generateSetupToken();

      const provisioningDetailsExisting = {
        flow: 'existing_website',
        wp_admin_login: null,
        wp_admin_password_set: false,
        provisioned_at: new Date().toISOString(),
        provision_code: provisionCode,
        tier,
        plugin_install_status: pluginInstallStatus,
        plugin_install_error: pluginInstallError,
        welcome_token: setupToken,
        ia_plugin_download_url: pluginDownloadUrl,
        current_phase: 'ready',
        current_percent: 100,
        current_message: 'Your site is connected to ARION!',
      };
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, session.site_id)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(provisioningDetailsExisting))
        .query(`
          UPDATE arion.site
          SET provisioning_state = 'ready',
              provisioned_at = SYSUTCDATETIME(),
              provisioning_details_json = @details,
              updated_at = GETUTCDATE()
          WHERE site_id = @siteId
        `);

      // Welcome email — include the plugin download URL so off-Hostinger
      // customers can install it themselves.
      await updatePhase(pool, session.site_id, 'sending_welcome');
      try {
        await sendOnboardingWelcomeEmail({
          toEmail: session.email,
          firstName: answers.contactFirstName || answers.firstName || '',
          brandName: answers.businessName,
          tenantId: session.tenant_id,
          wpAdminUrl,
          wpAdminLogin: null,       // we didn't create one
          wpAdminPassword: null,    // we didn't create one
          setupToken,
          iaPluginDownloadUrl: pluginDownloadUrl,
          existingWebsite: true,
        });
      } catch (emailErr) {
        console.error('[onboarding/submit] welcome email threw (existing-WP):', emailErr.message);
      }
      await updatePhase(pool, session.site_id, 'ready');
      return;
    }

    // ============================================================
    // NEW WORDPRESS BRANCH (paths #1/#3/#5/#7) — original full pipeline
    // ============================================================
    // 8. Generate credentials for the DB + admin user.
    const dbSuffix = String(session.tenant_id).slice(0, 8).toLowerCase().replace(/-/g, '');
    const dbName = `arion_${dbSuffix}`.slice(0, 18);
    const dbUser = `arion_${dbSuffix}`.slice(0, 18);
    const dbPassword = generatePassword();

    // 9. Hostinger API: createDatabase
    await updatePhase(pool, session.site_id, 'creating_database');
    const dbRes = await createDatabase({
      username: hostingerUsername,
      name: dbName,
      user: dbUser,
      password: dbPassword,
      websiteDomain: domain.domain,
    });
    if (!dbRes.ok && !isAlreadyExistsError(dbRes.error)) {
      throw new Error(`DB_CREATE_FAILED: ${dbRes.error}`);
    }

    // 10. Hostinger API: installWordPress
    await updatePhase(pool, session.site_id, 'installing_wordpress');
    const wpInstall = await installWordPress({
      username: hostingerUsername,
      domain: domain.domain,
      siteTitle: answers.businessName,
      credentials: { email: adminEmail, login: adminLogin, password: adminPassword },
    });
    if (!wpInstall.ok && !isAlreadyExistsError(wpInstall.error)) {
      throw new Error(`WP_INSTALL_FAILED: ${wpInstall.error}`);
    }

    // 11. Wait for WP to come online
    await updatePhase(pool, session.site_id, 'waiting_for_wp');
    const wpReady = await waitForWpReady(domain.domain);
    if (!wpReady) throw new Error(`WP_NOT_READY: ${domain.domain} did not respond within 2 min`);

    // 12. Make sure iaadmin has the generated password
    await updatePhase(pool, session.site_id, 'resetting_admin_password');
    await ensureAdminPassword({ domain: domain.domain, adminLogin, adminEmail, adminPassword });

    // 13. Strip Hostinger's onboarding plugins (they auto-install on fresh WP)
    await updatePhase(pool, session.site_id, 'stripping_hostinger');
    await stripHostingerOnboardingPlugins(domain.domain);

    // 14. Create the client's editor-level WP user
    await updatePhase(pool, session.site_id, 'creating_editor_user');
    await createClientEditor({
      domain: domain.domain,
      clientEmail: session.email,
      clientFirstName: (answers.contactFirstName || '').toString() || answers.businessName,
      clientLastName: (answers.contactLastName || '').toString() || '',
    });

    // 14b. Mint a WordPress application password for the iaadmin user so the
    //      downstream V2 publish steps (postElementorPage + setElementorGlobals)
    //      can authenticate against the WP REST API with HTTP Basic auth. WP
    //      5.6+ REJECTS Basic auth with the user's regular login password — only
    //      application passwords pass through the wp_authenticate_application_password
    //      filter, which is what produces the authenticated current_user for
    //      permission_callback to read.
    //
    //      `--porcelain` returns just the plaintext password (no UUID/header).
    //      The wp-cli command auto-generates a strong password; we cannot supply
    //      one. Token is held in-memory only and embedded in the in-memory site
    //      shim — never persisted longer than this background task.
    await updatePhase(pool, session.site_id, 'minting_publish_credentials');
    let iaadminAppPassword = null;
    try {
      const appPwResult = await mintIaadminAppPassword(domain.domain);
      iaadminAppPassword = appPwResult.appPassword;
      console.log(`[onboarding/submit] minted iaadmin application password for ${domain.domain} (len=${iaadminAppPassword?.length || 0})`);
    } catch (mintErr) {
      // Non-fatal: postElementorPage will still attempt the provision-code
      // header path; if the plugin route accepts it, publish still works.
      // If it doesn't, we'll see "Sorry, you are not allowed to do that."
      // in the publish results, surfaced via provisioning_details_json.
      console.warn(`[onboarding/submit] failed to mint iaadmin app password (non-fatal): ${mintErr.message.slice(0, 200)}`);
    }

    // 15. Install the Golden Master plugin stack (Elementor + Pro + IA Plugin).
    //     V2 dropped the astra-sites dependency — see overnight-report/38.
    await updatePhase(pool, session.site_id, 'installing_plugins');
    const tier = (answers.tier || session.tier || 'lite').toLowerCase();
    const installShop = answers.installShop === true || answers.needsShop === true;
    const stackResult = await installPluginsForTier({
      domain: domain.domain, tier, installShop,
      iaPluginDownloadUrl: pluginDownloadUrl, provisionCode,
    });

    // 16. Generate Claude copy from the questionnaire (kept as a per-block
    //     enrichment hint passed into the emitter pipeline). V2 emitters
    //     re-write the actual page sections from scratch but copyBundle gives
    //     a fallback if any emitter fails.
    await updatePhase(pool, session.site_id, 'generating_copy');
    const copyBundle = await generateSiteCopy(answers);

    // 17. NEW (V2 F-201) — Set Elementor Globals (brand colors + fonts) via
    //     the Elementor v1/globals REST API. Cascades automatically through
    //     every widget that references globals.primary / globals.heading_font
    //     so we don't have to touch each leaf node.
    //     Elementor REST needs Basic auth from a real WP user. We just
    //     provisioned iaadmin with adminPassword above; synthesize an in-
    //     memory site row that pluginClient.buildPluginAuth() will accept
    //     so setElementorGlobals can authenticate during onboarding.
    await updatePhase(pool, session.site_id, 'setting_brand_globals');
    // V2 publish auth — the WP REST API rejects Basic auth with the user's
    // regular password since WP 5.6+. Only application passwords pass the
    // wp_authenticate_application_password filter. If we minted one in step 14b
    // we use it here (and for postElementorPage below); otherwise we fall back
    // to the regular password which will fail Basic auth (caller falls back to
    // the provision-code header path).
    const publishCreds = iaadminAppPassword
      ? `${adminLogin}:${iaadminAppPassword}`
      : `${adminLogin}:${adminPassword}`;
    const onboardingSiteShim = {
      domain:               domain.domain,
      wp_admin_url:         wpAdminUrl,
      wp_app_password_ref:  publishCreds,
    };
    let globalsResult = { ok: false, error: 'not_attempted' };
    try {
      // setElementorGlobals tries POST /wp-json/elementor/v1/globals first
      // and, on 404 (endpoint is GET-only on the installed Elementor
      // version), automatically drops down to a wp-cli fallback over SSH
      // via lib/hostingerSsh.runWpCli (which pulls SSH creds from KV — the
      // same credentials we used to install plugins above). Returns
      // `{ ok: true, via: 'wp_cli' }` when the fallback applies.
      globalsResult = await setElementorGlobals({
        domain:         domain.domain,
        brandName:      answers.businessName,
        primaryColor:   answers.primaryColor,
        secondaryColor: answers.secondaryColor,
        accentColor:    answers.accentColor,
        site:           onboardingSiteShim,
      });
      if (globalsResult.ok && globalsResult.via === 'wp_cli') {
        console.log(`[onboarding/submit] Elementor globals applied via wp-cli fallback (REST POST 404'd) on ${domain.domain}`);
      }
    } catch (e) {
      globalsResult = { ok: false, error: e.message.slice(0, 300) };
      console.warn(`[onboarding/submit] setElementorGlobals failed (non-fatal): ${globalsResult.error}`);
    }

    // 17b. Also write the legacy ia_brand_* options via wp-cli so the IA
    //      Plugin's older brand readers still see the customer's colors.
    //      Soft-fails on off-Hostinger sites (rare here — this is the
    //      fresh-WP branch — but defensive).
    try {
      await applyBranding({
        domain: domain.domain,
        brandName: answers.businessName,
        primaryColor: answers.primaryColor,
        secondaryColor: answers.secondaryColor,
        accentColor: answers.accentColor,
      });
    } catch (e) {
      console.warn(`[onboarding/submit] legacy applyBranding skipped: ${e.message.slice(0, 200)}`);
    }

    // 18. NEW (V2 F-205) — Generate hero + section images via gpt-image-1.
    //     Soft-fails: emitters can fall back to image-less variants if no
    //     bundle is returned. imageBundle is consumed by the page generator
    //     through sectionContextFor() inside onboardingDriver.
    await updatePhase(pool, session.site_id, 'generating_images');
    let imageBundle = null;
    try {
      imageBundle = await generateSiteImages({
        answers,
        brandColors: {
          primary:   answers.primaryColor,
          secondary: answers.secondaryColor,
          accent:    answers.accentColor,
        },
        domain: domain.domain,
      });
    } catch (e) {
      console.warn(`[onboarding/submit] generateSiteImages failed (non-fatal): ${e.message.slice(0, 200)}`);
      imageBundle = null;
    }

    // 19. NEW (V2 F-204) — Generate Home + About + Services + Contact pages
    //     via the AI WB emitter pipeline. Each page is built from a
    //     kind-specific block sequence (see lib/websiteBuilder/onboardingDriver.js
    //     PAGE_BLUEPRINTS) and assembled into a single _elementor_data tree.
    await updatePhase(pool, session.site_id, 'generating_pages');
    const pages = await generateAllPages({
      domain:   domain.domain,
      answers,
      copyBundle,
      imageBundle,
      brandColors: {
        primary:   answers.primaryColor,
        secondary: answers.secondaryColor,
        accent:    answers.accentColor,
      },
      tenantId: session.tenant_id,
      siteId:   session.site_id,
    });

    // 20. NEW (V2 F-205) — POST each page's _elementor_data to the WP site via
    //     the IA Plugin's /pages/elementor route (plugin handler already
    //     shipped — see intelligent-analytics.php upsert_elementor_page).
    await updatePhase(pool, session.site_id, 'publishing_pages');
    const publishResults = [];
    for (const page of pages) {
      if (!page.elementorData || page.elementorData.length === 0) {
        publishResults.push({ slug: page.slug, ok: false, error: 'no_sections_built' });
        console.warn(`[onboarding/submit] page "${page.slug}" had zero sections — skipping publish`);
        continue;
      }
      const postResult = await postElementorPage({
        domain:        domain.domain,
        slug:          page.slug,
        title:         page.title,
        elementorData: page.elementorData,
        provisionCode,
        site:          onboardingSiteShim,
      });
      publishResults.push({
        slug:   page.slug,
        ok:     postResult.ok,
        postId: postResult.postId || null,
        error:  postResult.error || null,
      });
      if (!postResult.ok) {
        console.warn(`[onboarding/submit] publishing "${page.slug}" failed: ${postResult.error}`);
      }
    }

    // 21. NEW (V2 F-207) — Set Home as the static front page so visitors hit
    //     the marquee page instead of the blog roll.
    await updatePhase(pool, session.site_id, 'finalizing_homepage');
    let frontPageResult = { ok: false, error: 'not_attempted' };
    try {
      const homePub = publishResults.find((p) => p.slug === 'home');
      frontPageResult = await setStaticFrontPage({
        domain:        domain.domain,
        slug:          'home',
        pageId:        homePub?.postId || null,
        provisionCode,
        site:          onboardingSiteShim,
      });
    } catch (e) {
      frontPageResult = { ok: false, error: e.message.slice(0, 300) };
      console.warn(`[onboarding/submit] setStaticFrontPage failed (non-fatal): ${frontPageResult.error}`);
    }

    await updatePhase(pool, session.site_id, 'finishing_up');

    // 22. Generate the CIAM activation token for the welcome email link.
    const setupToken = generateSetupToken();

    // 23. Final state — site is ready. V2 provisioning details record the
    //     AI-WB pipeline outcomes (globals, images, page-by-page publish
    //     results, front-page flip) so the Portal status surface + customer
    //     support can see what happened on each onboarding run.
    const pageSummary = pages.map((p) => ({
      slug:          p.slug,
      sections_built: p.sectionsBuilt,
      skipped:       (p.skipped || []).length,
      emitter_ok:    (p.emitterResults || []).filter((r) => r.ok).length,
      emitter_fail:  (p.emitterResults || []).filter((r) => !r.ok).length,
    }));
    const provisioningDetails = {
      wp_admin_login: adminLogin,
      wp_admin_email: adminEmail,
      wp_admin_password_set: true,
      provisioned_at: new Date().toISOString(),
      provision_code: provisionCode,
      tier,
      install_shop: installShop,
      plugins_installed: stackResult.installed,
      plugins_skipped: stackResult.skipped,
      plugins_failed: stackResult.failed || [],
      // V2 AI Website Builder outcomes
      builder_version:        'v2',
      elementor_globals_set:  globalsResult.ok === true,
      elementor_globals_error: globalsResult.ok ? null : (globalsResult.error || null),
      images_generated:       imageBundle ? (imageBundle.stats?.succeeded ?? true) : false,
      images_failed:          imageBundle?.stats?.failed ?? null,
      pages_built:            pages.length,
      pages_summary:          pageSummary,
      pages_published:        publishResults,
      front_page_set:         frontPageResult.ok === true,
      front_page_source:      frontPageResult.source || null,
      front_page_error:       frontPageResult.ok ? null : (frontPageResult.error || null),
      copy_source:            copyBundle.source,
      welcome_token: setupToken,
      current_phase: 'ready',
      current_percent: 100,
      current_message: 'Your site is ready!',
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

    // 24. Send the "your site is ready + activate your portal" email. Best-effort
    //     but failures are now persisted into provisioning_details_json so the
    //     Portal can surface a "resend email" button.
    await updatePhase(pool, session.site_id, 'sending_welcome');
    let welcomeEmailStatus = 'unknown';
    let welcomeEmailError = null;
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
      welcomeEmailStatus = emailRes.ok ? 'sent' : 'failed';
      if (!emailRes.ok) {
        welcomeEmailError = (emailRes.error || '').slice(0, 300);
        console.warn('[onboarding/submit] welcome email failed:', welcomeEmailError);
      }
    } catch (emailErr) {
      welcomeEmailStatus = 'threw';
      welcomeEmailError = emailErr.message.slice(0, 300);
      console.error('[onboarding/submit] welcome email threw:', emailErr.message);
    }
    // Persist email status into provisioning_details_json for UI visibility
    try {
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, session.site_id)
        .input('status', sql.NVarChar(20), welcomeEmailStatus)
        .input('err', sql.NVarChar(300), welcomeEmailError)
        .query(`
          UPDATE arion.site
          SET provisioning_details_json = JSON_MODIFY(
                JSON_MODIFY(provisioning_details_json, '$.welcome_email_status', @status),
                '$.welcome_email_error', @err
              )
          WHERE site_id = @siteId
        `);
    } catch (e) { /* best-effort metadata write */ }
    await updatePhase(pool, session.site_id, 'ready');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * R2 — Auto-resume the onboarding submit when DNS finally lands.
 *
 * Polls nameservers every 30s for up to 30 min. As soon as they resolve to
 * Hostinger, internally re-invokes POST /onboarding/submit with the same body,
 * which kicks off the full provisioning pipeline. The customer never has to
 * manually retry — they just see `dns_verifying` until the build starts.
 *
 * Best-effort. If arion-api restarts mid-poll the resume dies and the
 * customer falls back to manually resubmitting (which still works).
 */
async function waitForDnsAndResubmit({ domain, sessionId, body, pool, siteId }) {
  const deadline = Date.now() + 30 * 60 * 1000;  // 30 min
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      const check = await verifyHostingerNameservers(domain);
      if (check.pointsToHostinger) {
        console.log(`[onboarding/submit/dns-resume] ${domain} resolved — auto-resubmitting`);
        const fetchUrl = `${ARION_API_BASE}/onboarding/submit`;
        await fetch(fetchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch((e) => console.error('[onboarding/submit/dns-resume] self-POST failed:', e.message));
        return;
      }
    } catch (e) {
      console.warn(`[onboarding/submit/dns-resume] check error: ${e.message}`);
    }
  }
  // Timed out — leave site in dns_verifying so customer can manually retry.
  console.warn(`[onboarding/submit/dns-resume] gave up after 30 min for ${domain}`);
}

/**
 * Validate a domain string as a FQDN.
 * Accepts: foo.com, sub.foo.com, multi.sub.foo.co.uk
 * Rejects: localhost, "my site", IP addresses, single-label hostnames
 */
function isValidFqdn(d) {
  const s = String(d || '').trim().toLowerCase();
  if (s.length < 4 || s.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(s);
}

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
 */
async function waitForWpReady(domain, timeoutMs = 300_000) {
  const start = Date.now();
  const url = `https://${domain}/wp-login.php`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (res.status === 200 || res.status === 302) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.warn(`[onboarding/submit] waitForWpReady gave up after ${timeoutMs}ms for ${domain}`);
  return false;
}

/**
 * Treat Hostinger "already exists" / "in use" / 409-style messages as
 * non-failures so partial-retry runs of /submit can progress.
 */
function isAlreadyExistsError(err) {
  const s = String(err || '').toLowerCase();
  return s.includes('already in use')
    || s.includes('already exists')
    || s.includes('already installed')
    || s.includes('must be unique')
    || s.includes('name is taken');
}

/**
 * Generate a strong WP admin / DB password. Hostinger's DB API rejects
 * passwords that lack at least one digit (HTTP 422 "password field must
 * contain at least one number"), so we guarantee one upper + one lower +
 * one digit + one symbol regardless of random luck.
 *
 * 20 chars total. Avoids visually-ambiguous chars (0/O, 1/l/I).
 */
function generatePassword() {
  const upper   = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower   = 'abcdefghijkmnpqrstuvwxyz';
  const digits  = '23456789';
  const symbols = '!@#$%^&*';
  const all     = upper + lower + digits + symbols;

  function pick(set) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return set[buf[0] % set.length];
  }

  // Guarantee one of each category, then fill the rest from the full set.
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < 20; i++) chars.push(pick(all));

  // Fisher-Yates shuffle so the required-category chars aren't always
  // at positions 0-3 (some password validators look at position).
  const buf = new Uint32Array(chars.length);
  crypto.getRandomValues(buf);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Mint a fresh WordPress application password for the iaadmin user via
 * wp-cli. Application passwords are the ONLY credential type WP REST will
 * accept as HTTP Basic auth since WP 5.6 — sending the regular login password
 * over Basic auth returns 401/"Sorry, you are not allowed to do that".
 *
 * `wp user application-password create <user> <name> --porcelain` prints just
 * the plaintext password (no UUID, no header). The 24-char password is shown
 * exactly once — WP stores only the hash — so we must capture stdout here.
 *
 * @param {string} domain  the customer domain (e.g. example.com)
 * @returns {Promise<{ appPassword: string }>}
 *   - throws if the wp-cli call fails or returns no password text
 */
async function mintIaadminAppPassword(domain) {
  const result = await runWpCli(
    domain,
    `user application-password create iaadmin "Arion V2 Onboarding" --porcelain`,
  );
  const appPassword = (result.stdout || '').trim();
  if (!appPassword || /\s/.test(appPassword)) {
    throw new Error(`unexpected wp-cli output for application-password create: "${appPassword.slice(0, 100)}"`);
  }
  return { appPassword };
}

export default router;
