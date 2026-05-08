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
  enableDomainLock,
  enablePrivacyProtection,
} from '../../lib/hostinger.js';
import { createJob, transitionState, getLatestJobForSite } from '../../lib/provisioningJobs.js';
import { dispatchJob } from '../../lib/workerClient.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';

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
      const purchaseRes = await registerPurchasedDomain(domain.domain, session.email);
      if (!purchaseRes.ok) {
        return res.status(502).json({ error: { code: 'DOMAIN_PURCHASE_FAILED', message: purchaseRes.error, status: 502 } });
      }
    }

    // 6. Create the WordPress install on Hostinger
    const adminPassword = generatePassword();
    const wpCreate = await createWebsite({
      domain: domain.domain,
      orderId: null, // arion-api uses default subscription on the Hostinger account
      adminEmail: session.email,
      adminPassword,
    });
    if (!wpCreate.ok) {
      return res.status(502).json({ error: { code: 'WP_CREATE_FAILED', message: wpCreate.error, status: 502 } });
    }
    const websiteId = wpCreate.data?.website_id || wpCreate.data?.id;
    const wpAdminUrl = wpCreate.data?.wp_admin_url || `https://${domain.domain}/wp-admin/`;

    // Persist what we know about the new WP install
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

    // 7. Build the AI prompt from answers
    const { prompt } = buildAiPrompt(answers);

    // 8. Issue a fresh provisioning code (or reuse existing pending one)
    const codeRes = await createProvisionCode(pool, {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      createdBy: 'onboarding_submit',
      ttlDays: 14,
    });

    // 9. Create the job + dispatch to worker
    const wpUser = session.email; // username = email (locked decision)
    const payload = {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      domain: domain.domain,
      websiteId,
      wpAdminUrl,
      wpUser,
      wpPass: adminPassword,
      prompt,
      brandName: answers.businessName,
      language: 'English',
      provisionCode: codeRes.code,
    };

    const job = await createJob(pool, {
      tenantId: session.tenant_id,
      siteId: session.site_id,
      signupSessionPk: session.session_pk,
      payload,
    });

    await pool.request()
      .input('sessionPk', sql.Int, session.session_pk)
      .input('jobId', sql.UniqueIdentifier, job.job_id)
      .query(`UPDATE arion.signup_session SET provisioning_job_id = @jobId WHERE session_pk = @sessionPk`);

    // Fire-and-forget dispatch to worker; mark job as dispatched optimistically.
    // If dispatch fails we transition to 'failed' so the UI surfaces the error.
    dispatchJob({ jobId: job.job_id, ...payload })
      .then(async (r) => {
        if (r.ok) {
          await transitionState(pool, job.job_id, 'dispatched', { message: 'queued in worker' });
        } else {
          await transitionState(pool, job.job_id, 'failed', { error: 'Worker dispatch failed: ' + r.error });
        }
      })
      .catch((err) => {
        console.error('[onboarding/submit] dispatch error:', err);
      });

    return res.status(202).json({
      data: { job_id: job.job_id, state: 'queued' },
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
 * Register a purchased domain via Hostinger. We need a WHOIS profile first;
 * this helper creates one synthesized from the signup email + minimal placeholder
 * data. Real WHOIS contact info is collected post-signup in account settings.
 *
 * NOTE: Hostinger's API may reject placeholder addresses for certain TLDs (.us, etc.).
 * This needs hardening — for now we use the email's domain as a stand-in and rely
 * on the user updating their WHOIS profile from Settings before renewal.
 */
async function registerPurchasedDomain(domain, email) {
  const tld = domain.split('.').pop();
  const [first, last] = parseNameFromEmail(email);
  const whoisRes = await createWhoisProfile({
    tld,
    country: 'US',
    entity_type: 'individual',
    first_name: first,
    last_name: last,
    email,
    phone: '+15555555555',
    address1: 'TBD — set in Settings',
    city: 'TBD',
    state: 'TX',
    zip: '00000',
  });
  if (!whoisRes.ok) {
    return { ok: false, error: 'WHOIS profile creation failed: ' + whoisRes.error };
  }
  const whoisProfileId = whoisRes.data?.id || whoisRes.data?.profile_id;

  const purchase = await purchaseDomain({
    domain,
    whoisProfileId,
    period: 1,
    privacyProtection: true,
  });
  if (!purchase.ok) {
    return { ok: false, error: 'Domain purchase failed: ' + purchase.error };
  }
  // Best-effort hardening
  enableDomainLock(domain).catch(() => {});
  enablePrivacyProtection(domain).catch(() => {});
  return { ok: true, order_id: purchase.data?.order_id };
}

function parseNameFromEmail(email) {
  const local = String(email).split('@')[0] || 'New';
  const parts = local.split(/[._+-]+/);
  const first = capitalize(parts[0] || 'New');
  const last = capitalize(parts[1] || 'Customer');
  return [first, last];
}

function capitalize(s) {
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
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
