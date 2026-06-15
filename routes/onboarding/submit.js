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
  enableDomainLock,
  enablePrivacyProtection,
} from '../../lib/hostinger.js';
import {
  stripHostingerOnboardingPlugins,
  createClientEditor,
  applyBranding,
} from '../../lib/hostingerSsh.js';
import { installPluginsForTier } from '../../lib/pluginStack.js';
import { driveHpanelBuild } from '../../lib/browserDriver.js';
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

    // 6. Persist initial site state (queued). The actual hosting slot + WP
    //    install is created BY KODEE during the browser-driven hPanel flow,
    //    not via REST API. The slot URL is what we already know — Hostinger's
    //    AI builder lands at the same subdomain we tell it to use.
    const wpAdminUrl = `https://${domain.domain}/wp-admin/`;
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, session.site_id)
      .input('wpAdminUrl', sql.NVarChar(500), wpAdminUrl)
      .input('domain', sql.NVarChar(253), domain.domain)
      .input('domainMode', sql.NVarChar(20), domain.mode)
      .input('primaryColor', sql.NVarChar(20), answers.primaryColor || null)
      .query(`
        UPDATE arion.site
        SET wp_admin_url = @wpAdminUrl,
            domain = @domain,
            domain_mode = @domainMode,
            branding_primary_color = @primaryColor,
            provisioning_state = 'queued',
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);
    await updatePhase(pool, session.site_id, 'queued');

    // === ASYNC HANDOFF ===
    // Everything up to here is fast (validation + persistence). The hPanel
    // browser flow takes 5-15 minutes (login + Kodee AI build + plugin
    // stack + branding). Return 202 immediately so the customer's browser
    // gets to the progress page. The actual work runs in the background;
    // status endpoint reads phase from arion.site.
    res.status(202).json({
      data: {
        site_id: session.site_id,
        tenant_id: session.tenant_id,
        domain: domain.domain,
        wp_admin_url: wpAdminUrl,
        provisioning_state: 'queued',
        status_url: `/onboarding/status?session_id=${encodeURIComponent(session_id)}`,
        estimated_seconds: 900, // ~15 min worst case; UI shows "up to 60" for ARION
      },
      meta: { timestamp: new Date().toISOString() },
    });

    // Fire-and-forget orchestration. .unref()-style guard via process.nextTick
    // isn't needed because Express keeps the worker alive; we just don't want
    // to block the response.
    setImmediate(async () => {
      try {
        await runProvisioningBackground({
          pool, session, domain, answers, wpAdminUrl,
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
async function runProvisioningBackground({ pool, session, domain, answers, wpAdminUrl }) {
    // 7. Issue provisioning code FIRST — the IA Plugin download URL embeds it.
    const codeRes = await createProvisionCode(pool, {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      createdBy: 'onboarding_submit',
      ttlDays: 14,
    });
    const provisionCode = codeRes.code;
    const pluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(provisionCode)}`;

    // 8. Generate the WP admin credentials Kodee will set on the new site.
    const adminLogin = 'iaadmin';
    const adminPassword = generatePassword();
    const adminEmail = answers.email || session.email || process.env.IA_STAFF_ADMIN_EMAIL || 'info@intelligentanalyticsdm.com';

    // 9. Build the questionnaire-derived AI prompt.
    const { prompt: aiPrompt } = buildAiPrompt(answers);

    // 10. Drive Hostinger's hPanel AI Website Builder via browser-driver Container
    //     App. This step:
    //       - logs into hpanel.hostinger.com as the master account
    //       - clicks Add Website on a plan card with capacity
    //       - selects WordPress
    //       - sets the admin email + password we generated above
    //       - chooses "Create a website with AI"
    //       - fills the prompt + brand panels
    //       - waits for Kodee to finish building
    //     On completion, Hostinger has provisioned the WP install + database +
    //     created the iaadmin user with our generated password. No further
    //     site-creation calls needed.
    await updatePhase(pool, session.site_id, 'hpanel_login');
    await updatePhase(pool, session.site_id, 'kodee_building');
    let kodeeResult;
    try {
      kodeeResult = await driveHpanelBuild({
        subdomain: domain.domain,
        wpAdminEmail: adminEmail,
        wpAdminPassword: adminPassword,
        prompt: aiPrompt,
        brandName: answers.businessName,
        primaryColor: answers.primaryColor,
        secondaryColor: answers.secondaryColor,
        accentColor: answers.accentColor,
      });
    } catch (drvErr) {
      console.error('[onboarding/submit] browser-driver call failed:', drvErr.message);
      kodeeResult = { status: 'failed', duration_ms: 0, screenshots: [], error: drvErr.message };
    }
    if (kodeeResult.status !== 'completed') {
      // Hard failure — without Kodee creating the site, we have nothing to
      // SSH into. Mark failed and stop.
      throw new Error(`HPANEL_BUILD_FAILED: ${kodeeResult.error || 'unknown'}`);
    }

    // 11. Strip Hostinger's stock onboarding plugins. SSH wp-cli works against
    //     the live WP install Kodee created.
    await updatePhase(pool, session.site_id, 'stripping_hostinger');
    await stripHostingerOnboardingPlugins(domain.domain);

    // 12. Create the client's editor-level WP user.
    await updatePhase(pool, session.site_id, 'creating_editor_user');
    await createClientEditor({
      domain: domain.domain,
      clientEmail: session.email,
      clientFirstName: (answers.contactFirstName || '').toString() || answers.businessName,
      clientLastName: (answers.contactLastName || '').toString() || '',
    });

    // 13. Install the Golden Master plugin stack for this tenant's tier.
    await updatePhase(pool, session.site_id, 'installing_plugins');
    const tier = (answers.tier || session.tier || 'lite').toLowerCase();
    const installShop = answers.installShop === true || answers.needsShop === true;
    const stackResult = await installPluginsForTier({
      domain: domain.domain,
      tier,
      installShop,
      iaPluginDownloadUrl: pluginDownloadUrl,
      provisionCode,
    });

    // 14. Apply branding via SSH wp-cli. Kodee will have set some colors based
    //     on what we sent in the AI build panels, but the customer's exact
    //     hex values from the questionnaire become the authoritative source.
    await updatePhase(pool, session.site_id, 'applying_branding');
    await applyBranding({
      domain: domain.domain,
      brandName: answers.businessName,
      primaryColor: answers.primaryColor,
      secondaryColor: answers.secondaryColor,
      accentColor: answers.accentColor,
    });

    await updatePhase(pool, session.site_id, 'finishing_up');

    // 15. Generate the CIAM activation token for the welcome email link.
    const setupToken = generateSetupToken();

    // 16. Final state — site is ready. Provisioning details captured for ops.
    const provisioningDetails = {
      wp_admin_login: adminLogin,
      wp_admin_email: adminEmail,
      wp_admin_password_set: true,
      provisioned_at: new Date().toISOString(),
      provision_code: provisionCode,
      ai_prompt_chars: aiPrompt.length,
      tier,
      install_shop: installShop,
      plugins_installed: stackResult.installed,
      plugins_skipped: stackResult.skipped,
      kodee_status: kodeeResult.status,
      kodee_duration_ms: kodeeResult.duration_ms,
      kodee_final_url: kodeeResult.finalUrl || null,
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

    // 21. Send the "your site is ready + activate your portal" email. Best-effort.
    await updatePhase(pool, session.site_id, 'sending_welcome');
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
    await updatePhase(pool, session.site_id, 'ready');
}

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

export default router;
