/**
 * Onboarding — Runner Orchestrator Endpoints
 * --------------------------------------------------------------------------
 * Surface for the Portal-side OnboardingRunner (engine in
 * Portal/src/lib/onboardingRunner/). Each endpoint maps 1:1 to a Step
 * declared in Portal/src/lib/onboardingRunner/arionSteps.ts.
 *
 * Why these are separate from the existing /onboarding/submit orchestrator:
 *   • /onboarding/submit is the legacy public BUY-FLOW orchestrator. It runs
 *     during the unauthenticated guest-checkout signup; auth is the signup
 *     session_id. The whole pipeline runs as one async background task.
 *   • The Runner is for the AUTHENTICATED post-checkout wizard. The user
 *     (or founder) is logged in, the tenant + arion.site row already exist,
 *     and the engine wants to step through one phase at a time so the UI can
 *     render live progress.
 *
 * Status mirror — every endpoint writes the canonical status into
 *   arion.site.status_phase    (NVarChar(40))
 *   arion.site.provisioning_details_json.current_phase
 * so GET /onboarding/runner/status/:tenantId/:siteId can return a normalised
 * snapshot the engine polls.
 *
 * Auth: standard JWT+tenant chain. Tenant scope is asserted on every write —
 * caller's resolved tenant_id MUST match the body tenant_id.
 *
 * Brandon decision #3 retry ladder: every endpoint surfaces a clear, terse
 * error when something fails. The Portal engine re-attempts up to
 * max_retries per step before flipping to failed_server_busy and pinging
 * the founder via the oliver-api notify-stuck route.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { updatePhase, markFailed } from '../../lib/provisioningPhase.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';
import { plugin as pluginApi } from '../../lib/pluginClient.js';
import { mergedInternalIps } from '../../lib/internalTraffic.js';
import { BASE_TIER_LADDER, syncSiteTiersFromPurchase } from '../../lib/purchaseTierSync.js';

const router = Router();

/* ──────────────────────────────────────────────────────────────────────
 * Tenant scope guard
 * ────────────────────────────────────────────────────────────────────── */

function assertTenantScope(req, res, bodyTenant) {
  const callerTenant = String(req.tenant?.tenantId || '').toUpperCase();
  const bodyTid = String(bodyTenant || '').toUpperCase();
  if (!callerTenant) {
    res.status(401).json({ error: { code: 'NO_TENANT', message: 'No tenant resolved', status: 401 } });
    return false;
  }
  if (bodyTid && bodyTid !== callerTenant) {
    res.status(403).json({ error: { code: 'TENANT_MISMATCH', message: 'Body tenant_id does not match auth tenant', status: 403 } });
    return false;
  }
  return true;
}

/**
 * verifySiteOwnership — confirms `site_id` belongs to `tenantId` before any
 * write. Previously every runner endpoint took `site_id` from req.body and
 * UPDATEd / fired events against it without cross-checking the tenant,
 * meaning tenant A could flip tenant B's `status_phase`, re-enqueue
 * Hostinger SSH provisioning against the wrong domain, or mint editor
 * users on the wrong WordPress. Audit finding 3.19. Returns the site row
 * on success or false on miss (caller sends 404).
 *
 * 2026-06-27 — Added.
 */
async function verifySiteOwnership(pool, tenantId, siteId) {
  if (!siteId) return false;
  try {
    const r = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('sid', sql.UniqueIdentifier, siteId)
      .query(`SELECT TOP 1 site_id, domain, tenant_id, status_phase, provisioning_state
                FROM arion.site WHERE site_id = @sid AND tenant_id = @tid`);
    return r.recordset[0] || false;
  } catch (e) {
    console.warn('[runner verifySiteOwnership]', e?.message);
    return false;
  }
}

function send404SiteNotFound(res) {
  return res.status(404).json({ error: { code: 'SITE_NOT_FOUND', message: 'site_id not found for this tenant', status: 404 } });
}

/* ──────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────── */

/**
 * arion.tenant.plan → arion.site.arion_tier. Only a base-ladder word
 * (lite/standard/pro/business/enterprise) is ever stamped; legacy SEO-ladder
 * values ('starter', 'growth' — the pre-2026-08-21 webhook default) and
 * anything unknown return null so nothing false is written.
 */
export function arionTierFromTenantPlan(plan) {
  const p = String(plan ?? '').trim().toLowerCase();
  return BASE_TIER_LADDER.includes(p) ? p : null;
}

/**
 * Exported for tests (fake pool + injected fetchSubscription).
 *
 * Phase B1 (2026-08-22): the placeholder INSERT used to write no arion_tier,
 * so every runner-created site took the column default ('lite' — the column
 * is NOT NULL DEFAULT 'lite', migration 001) and middleware/requireArionTier.js
 * then resolved a positive Lite and LOCKED Standard+ surfaces for a paying
 * Pro/Business tenant. Now: stamp the tenant's plan when it is a base-ladder
 * word, and raise from the Stripe subscription line items right after the
 * insert (best-effort — a Stripe/DB hiccup never fails the runner). When the
 * plan is unmappable the column default still applies (NULL cannot be
 * written); the purchase sync and migration 053 are the raise path.
 */
export async function loadOrCreateSiteRow(pool, tenantId, domain, domainPath, { fetchSubscription } = {}) {
  // Reuse the first site for the tenant if present (1-site cap on lower
  // tiers; multi-site Business tenants would re-run the wizard per site).
  const existing = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`SELECT TOP 1 site_id, domain, status_phase FROM arion.site WHERE tenant_id = @tid ORDER BY created_at`);
  if (existing.recordset.length) return existing.recordset[0];

  // Base tier + subscription from the tenant row (written by the Stripe
  // webhook at checkout). Founder-initiated flows may have no arion.tenant.
  let tenantPlan = null;
  let stripeSubscriptionId = null;
  try {
    const t = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 [plan], stripe_subscription_id FROM arion.tenant WHERE tenant_id = @tid`);
    tenantPlan = t.recordset?.[0]?.plan ?? null;
    stripeSubscriptionId = t.recordset?.[0]?.stripe_subscription_id || null;
  } catch (e) {
    console.warn('[runner loadOrCreateSiteRow] arion.tenant lookup failed; site gets the column default:', e?.message);
  }
  const arionTier = arionTierFromTenantPlan(tenantPlan);

  // Insert a placeholder row so subsequent steps can use the site_id.
  const r = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('domain', sql.NVarChar(253), domain || '')
    .input('domainMode', sql.NVarChar(20), domainPath || 'byo')
    .input('arionTier', sql.NVarChar(20), arionTier)
    .query(arionTier ? `
      DECLARE @sid UNIQUEIDENTIFIER = NEWID();
      INSERT INTO arion.site (site_id, tenant_id, domain, domain_mode, arion_tier, status_phase, provisioning_state, created_at)
      VALUES (@sid, @tid, @domain, @domainMode, @arionTier, 'questionnaire_saved', 'queued', SYSDATETIMEOFFSET());
      SELECT site_id, domain, status_phase FROM arion.site WHERE site_id = @sid;
    ` : `
      DECLARE @sid UNIQUEIDENTIFIER = NEWID();
      INSERT INTO arion.site (site_id, tenant_id, domain, domain_mode, status_phase, provisioning_state, created_at)
      VALUES (@sid, @tid, @domain, @domainMode, 'questionnaire_saved', 'queued', SYSDATETIMEOFFSET());
      SELECT site_id, domain, status_phase FROM arion.site WHERE site_id = @sid;
    `);
  const site = r.recordset[0];

  // Raise arion_tier / seo_addon_tier from what the tenant actually bought.
  // syncSiteTiersFromPurchase never throws; the outer try is belt-and-braces
  // so nothing here can fail the questionnaire step.
  if (site?.site_id && stripeSubscriptionId) {
    try {
      await syncSiteTiersFromPurchase(pool, {
        tenantId, siteId: site.site_id, subscriptionId: stripeSubscriptionId, source: 'runner',
        ...(fetchSubscription ? { fetchSubscription } : {}),
      });
    } catch (e) {
      console.error('[runner loadOrCreateSiteRow] purchase tier sync failed (non-fatal):', e?.message);
    }
  }
  return site;
}

async function setStatusPhase(pool, siteId, phase, tenantId) {
  // 2026-06-27 — Accept tenantId so the UPDATE WHERE clause includes
  // `AND tenant_id = @tid`. Belt-and-suspenders: callers should already
  // have called verifySiteOwnership, but the tenant filter on the UPDATE
  // protects against race conditions and bugs where a caller forgets to
  // verify.
  try {
    const r = pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('phase', sql.NVarChar(60), phase);
    let whereClause = 'WHERE site_id = @sid';
    if (tenantId) {
      r.input('tid', sql.UniqueIdentifier, tenantId);
      whereClause += ' AND tenant_id = @tid';
    }
    await r.query(`
      IF COL_LENGTH('arion.site', 'status_phase') IS NOT NULL
        UPDATE arion.site SET status_phase = @phase, updated_at = GETUTCDATE() ${whereClause};
    `);
  } catch (e) { /* never block */ }
  try { await updatePhase(pool, siteId, phase); } catch (e) { /* never block */ }
}

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/questionnaire
 *   Body: { tenant_id, domain_path, domain, questionnaire, run_id }
 *   Output: { data: { ok, site_id } }
 * ────────────────────────────────────────────────────────────────────── */
router.post('/questionnaire', async (req, res) => {
  const { tenant_id, domain_path, domain, questionnaire } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const site = await loadOrCreateSiteRow(pool, tid, domain || '', domain_path || 'byo');

    // Persist questionnaire JSON onto the site (and signup_session if one
    // exists). The legacy signup flow writes questionnaire_json there;
    // mirror that so downstream legacy code (welcomeEmail, aiCopy) finds
    // it in the same shape.
    // 2026-08-16 — REMOVED a mirror that wrote questionnaire_json onto
    // arion.site. That column does not exist there (it lives on
    // arion.signup_session), so the statement threw on every run and was
    // soft-failed with "column may not exist on older schemas". The real
    // write follows immediately below, so nothing is lost.

    // Also push into arion.signup_session if there is one for this tenant
    // (founder-initiated flows may not have a session row).
    await pool.request()
      .input('tid', sql.UniqueIdentifier, tid)
      .input('q', sql.NVarChar(sql.MAX), JSON.stringify(questionnaire || {}))
      .query(`
        UPDATE TOP (1) arion.signup_session
           SET questionnaire_json = @q,
               questionnaire_submitted_at = SYSDATETIMEOFFSET()
         WHERE tenant_id = @tid;
      `).catch(() => { /* may not exist */ });

    await setStatusPhase(pool, site.site_id, 'questionnaire_saved', tid);
    return res.json({ data: { ok: true, site_id: site.site_id } });
  } catch (err) {
    console.error('[onboarding/runner/questionnaire]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/mark-for-consulting
 *   migrate-path terminal step. Flags the tenant for consulting and
 *   inserts a consulting handoff row.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/mark-for-consulting', async (req, res) => {
  const { tenant_id, site_id, domain, notes } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();

    // 2026-06-27 — verify site_id belongs to this tenant before any write.
    if (site_id) {
      const owned = await verifySiteOwnership(pool, tid, site_id);
      if (!owned) return send404SiteNotFound(res);

      // Flag on arion.site — column may be new, soft-fail if missing.
      await pool.request()
        .input('sid', sql.UniqueIdentifier, site_id)
        .input('tid', sql.UniqueIdentifier, tid)
        .query(`
          IF COL_LENGTH('arion.site', 'consulting_migration_queued_at') IS NOT NULL
            UPDATE arion.site
               SET consulting_migration_queued_at = SYSDATETIMEOFFSET(),
                   status_phase = 'consulting_migration_queued',
                   updated_at = GETUTCDATE()
             WHERE site_id = @sid AND tenant_id = @tid;
        `).catch(() => { /* column-absent fallback below */ });
      await setStatusPhase(pool, site_id, 'consulting_migration_queued', tid);
    }

    // Always fire a platform event so iadm-webhooks/notification-processor
    // picks it up and the founder sees the migration in the consulting hub.
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.consulting_migration_queued',
      eventRefId: site_id || null,
      payload: { tenant_id: tid, site_id: site_id || null, domain: domain || null, notes: notes || null },
    }).catch(() => { /* event firing is best-effort */ });

    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/mark-for-consulting]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/hostinger-provision
 *   Kicks off the legacy provisioning pipeline by setting provisioning_state
 *   to 'queued' and writing the queued phase. The existing async workers
 *   (lib/integrationKickoff.js etc.) pick up the queued row and run the
 *   side-effect; this endpoint just enqueues so the runner waitFor can
 *   poll the status. Idempotent — repeated calls are no-ops once status
 *   is past 'queued'.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/hostinger-provision', async (req, res) => {
  const { tenant_id, site_id, domain } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id || !domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id + domain required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);

    await setStatusPhase(pool, site_id, 'creating_hosting', tid);
    // Mark queued — the legacy /onboarding/submit pipeline + worker dispatch
    // already covers the actual Hostinger SSH work. Enqueueing here keeps
    // the runner's contract simple: action() returns once the side-effect
    // is durably queued; waitFor() polls until it lands.
    await pool.request()
      .input('sid', sql.UniqueIdentifier, site_id)
      .input('tid', sql.UniqueIdentifier, tid)
      .query(`
        UPDATE arion.site
           SET provisioning_state = CASE WHEN provisioning_state = 'ready' THEN provisioning_state ELSE 'queued' END,
               updated_at = GETUTCDATE()
         WHERE site_id = @sid AND tenant_id = @tid;
      `);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.hostinger_provision_requested',
      eventRefId: site_id,
      payload: { site_id, domain },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/hostinger-provision]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/plugin-stack-swap
 *   Strips Hostinger onboarding plugins + installs the golden-master plugin
 *   stack on the customer's new WP site. The actual work is done by the
 *   existing background pipeline; this endpoint emits the status transition
 *   and fires the platform event the worker subscribes to.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/plugin-stack-swap', async (req, res) => {
  const { tenant_id, site_id, domain } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'installing_plugins', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.plugin_swap_requested',
      eventRefId: site_id,
      payload: { site_id, domain: domain || null, mode: 'full_stack' },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/plugin-stack-swap]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/plugin-install-only
 *   Path-B: install only the IA Plugin on an existing WP site. Customer's
 *   other plugins are theirs to manage. Soft-falls to email-only delivery
 *   when SSH can't reach the site (off-Hostinger).
 * ────────────────────────────────────────────────────────────────────── */
router.post('/plugin-install-only', async (req, res) => {
  const { tenant_id, site_id, domain } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'installing_plugins', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.plugin_swap_requested',
      eventRefId: site_id,
      payload: { site_id, domain: domain || null, mode: 'ia_plugin_only' },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/plugin-install-only]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/create-wp-user
 *   Mints an editor-level WP user for the customer. Same handler for
 *   purchase / subdomain / byo / hostinger_existing paths.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/create-wp-user', async (req, res) => {
  const { tenant_id, site_id, domain } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'creating_editor_user', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.create_wp_user_requested',
      eventRefId: site_id,
      payload: { site_id, domain: domain || null },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/create-wp-user]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/ai-website-builder
 *   Path-A only: AI Website Builder pipeline (copy, images, Elementor
 *   publish). The heavy V2 work lives in lib/websiteBuilder/ and is
 *   driven by background workers — this endpoint just emits the queued
 *   status and event.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/ai-website-builder', async (req, res) => {
  const { tenant_id, site_id, domain } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'generating_pages', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.ai_website_builder_requested',
      eventRefId: site_id,
      payload: { site_id, domain: domain || null },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/ai-website-builder]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/seo-keywords-seed
 *   Seeds the per-tier starter keyword set based on the questionnaire.
 *   The actual SE Ranking write lives in lib/seoOnboarding.js; this
 *   endpoint just queues the work + records the queued status.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/seo-keywords-seed', async (req, res) => {
  const { tenant_id, site_id, questionnaire } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'seeding_keywords', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.seo_keywords_seed_requested',
      eventRefId: site_id,
      payload: { site_id, questionnaire: questionnaire || {} },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/seo-keywords-seed]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/seo-competitors-seed
 *   Seeds competitor domains from the questionnaire into SE Ranking.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/seo-competitors-seed', async (req, res) => {
  const { tenant_id, site_id, questionnaire } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'seeding_competitors', tid);
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.seo_competitors_seed_requested',
      eventRefId: site_id,
      payload: { site_id, questionnaire: questionnaire || {} },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true } });
  } catch (err) {
    console.error('[onboarding/runner/seo-competitors-seed]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/bing-oauth-start
 *   Returns the Bing Webmaster OAuth start URL. Same shape as the Google
 *   OAuth start route — the Portal opens it in a popup.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/bing-oauth-start', async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);
    await setStatusPhase(pool, site_id, 'awaiting_bing_oauth', tid);
    // Production: lib/bingWebmaster.js owns the OAuth URL builder. For
    // now, mark queued so the engine waits for the integration row.
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.bing_oauth_requested',
      eventRefId: site_id,
      payload: { site_id },
    }).catch(() => {});
    return res.json({ data: { ok: true, queued: true, authUrl: null } });
  } catch (err) {
    console.error('[onboarding/runner/bing-oauth-start]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/runner/push-ga4-measurement-id
 *   F-Onb-D1 — push the GA4 measurement_id (already persisted on arion.site
 *   by the google-oauth auto-provision step) to the IA WordPress plugin so
 *   it auto-injects the gtag snippet. The measurement_id is always read
 *   from arion.site.ga4_measurement_id — any body-supplied value is
 *   ignored to avoid injecting an unvalidated tracking ID into the
 *   customer's site. The plugin side respects the `ia_ga4_gtag_enabled`
 *   WP filter hook so customers can opt out.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/push-ga4-measurement-id', async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const owned = await verifySiteOwnership(pool, tid, site_id);
    if (!owned) return send404SiteNotFound(res);

    // Load the full site row — pluginApi.* helpers need site_token_raw,
    // domain, wp_admin_url, wp_app_password_ref to authenticate the push.
    const siteRes = await pool.request()
      .input('sid', sql.UniqueIdentifier, site_id)
      .input('tid', sql.UniqueIdentifier, tid)
      .query(`SELECT TOP 1 site_id, tenant_id, domain, site_token_raw,
                     wp_admin_url, wp_app_password_ref, ga4_measurement_id
              FROM arion.site
              WHERE site_id = @sid AND tenant_id = @tid`);
    const site = siteRes.recordset[0];
    if (!site) return send404SiteNotFound(res);

    const measurement_id = site.ga4_measurement_id;
    if (!measurement_id) {
      return res.status(409).json({ error: { code: 'no_ga4_measurement_id', message: 'arion.site.ga4_measurement_id is not set — provision GA4 first', status: 409 } });
    }

    // Sept-A F4: carry the merged internal-traffic exclusion list on every
    // GA4 config push so a fresh site starts filtered from day one.
    const pushRes = await pluginApi.ga4MeasurementIdSet(site, { measurement_id, internal_ip_list: mergedInternalIps(site) });
    const pushed_at = new Date().toISOString();
    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.ga4_measurement_id_pushed',
      eventRefId: site_id,
      payload: { site_id, measurement_id, pushed_at, plugin_ok: !!pushRes?.ok },
    }).catch(() => {});

    return res.json({ data: { ok: true, measurement_id, pushed_at, plugin: pushRes } });
  } catch (err) {
    console.error('[onboarding/runner/push-ga4-measurement-id]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * GET /onboarding/runner/status/:tenantId/:siteId
 *   The polling endpoint the Portal Runner hits between attempts. Returns
 *   a normalised payload the per-step waitFor() can switch off without
 *   pinging multiple endpoints.
 * ────────────────────────────────────────────────────────────────────── */
router.get('/status/:tenantId/:siteId', async (req, res) => {
  const { tenantId, siteId } = req.params;
  const callerTenant = String(req.tenant?.tenantId || '').toUpperCase();
  if (!callerTenant || callerTenant !== String(tenantId || '').toUpperCase()) {
    return res.status(403).json({ error: { code: 'TENANT_MISMATCH', message: 'Caller tenant does not match URL tenant', status: 403 } });
  }
  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1
          site_id,
          tenant_id,
          domain,
          provisioning_state,
          provisioning_details_json,
          (CASE WHEN COL_LENGTH('arion.site', 'status_phase') IS NOT NULL THEN
            JSON_VALUE((SELECT status_phase = (SELECT status_phase FROM arion.site WHERE site_id = @sid)
                FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), '$.status_phase')
            ELSE NULL END) AS status_phase_fallback
        FROM arion.site
        WHERE site_id = @sid AND tenant_id = @tid;
      `).catch(async () => {
        // simpler fallback when JSON_VALUE-on-the-fly didn't fly (older
        // SQL Server) — just SELECT and handle in JS.
        return pool.request()
          .input('sid', sql.UniqueIdentifier, siteId)
          .input('tid', sql.UniqueIdentifier, tenantId)
          .query(`SELECT TOP 1 site_id, tenant_id, domain, provisioning_state, provisioning_details_json FROM arion.site WHERE site_id = @sid AND tenant_id = @tid`);
      });
    if (!r.recordset.length) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    const row = r.recordset[0];
    let pd = null;
    try { pd = row.provisioning_details_json ? JSON.parse(row.provisioning_details_json) : null; } catch { /* noop */ }

    // Try a focused status_phase read (column exists or not).
    // 2026-06-27 — tenant_id filter added; outer query already 404s on
    // tenant mismatch but belt-and-suspenders.
    let statusPhase = null;
    try {
      const phaseRes = await pool.request()
        .input('sid', sql.UniqueIdentifier, siteId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .query(`SELECT status_phase FROM arion.site WHERE site_id = @sid AND tenant_id = @tid`);
      statusPhase = phaseRes.recordset?.[0]?.status_phase || null;
    } catch { /* column may not exist */ }

    const currentPhase = pd?.current_phase || null;
    let terminalState = null;
    if (row.provisioning_state === 'ready' || currentPhase === 'ready') terminalState = 'done';
    if (row.provisioning_state === 'failed' || currentPhase === 'failed') terminalState = 'failed';

    return res.json({
      data: {
        current_phase: currentPhase,
        status_phase: statusPhase,
        progress_percent: Number(pd?.current_percent || 0),
        terminal_state: terminalState,
        error: terminalState === 'failed' ? (pd?.current_message || null) : null,
        evidence: {
          provisioning_state: row.provisioning_state,
          domain: row.domain,
        },
      },
    });
  } catch (err) {
    console.error('[onboarding/runner/status]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
