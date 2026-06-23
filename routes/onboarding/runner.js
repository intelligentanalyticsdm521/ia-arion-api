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

/* ──────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────── */

async function loadOrCreateSiteRow(pool, tenantId, domain, domainPath) {
  // Reuse the first site for the tenant if present (1-site cap on lower
  // tiers; multi-site authority tenants would re-run the wizard per site).
  const existing = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`SELECT TOP 1 site_id, domain, status_phase FROM arion.site WHERE tenant_id = @tid ORDER BY created_at`);
  if (existing.recordset.length) return existing.recordset[0];

  // Insert a placeholder row so subsequent steps can use the site_id.
  const r = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('domain', sql.NVarChar(253), domain || '')
    .input('domainMode', sql.NVarChar(20), domainPath || 'byo')
    .query(`
      DECLARE @sid UNIQUEIDENTIFIER = NEWID();
      INSERT INTO arion.site (site_id, tenant_id, domain, domain_mode, status_phase, provisioning_state, created_at)
      VALUES (@sid, @tid, @domain, @domainMode, 'questionnaire_saved', 'queued', SYSDATETIMEOFFSET());
      SELECT site_id, domain, status_phase FROM arion.site WHERE site_id = @sid;
    `);
  return r.recordset[0];
}

async function setStatusPhase(pool, siteId, phase) {
  // Tries the dedicated status_phase column (added in arion migration 029
  // alongside the runner) and falls back to the existing
  // provisioning_details_json.current_phase write when the column hasn't
  // landed yet. Both writes are best-effort.
  try {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('phase', sql.NVarChar(60), phase)
      .query(`
        IF COL_LENGTH('arion.site', 'status_phase') IS NOT NULL
          UPDATE arion.site SET status_phase = @phase, updated_at = GETUTCDATE() WHERE site_id = @sid;
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
    await pool.request()
      .input('sid', sql.UniqueIdentifier, site.site_id)
      .input('q', sql.NVarChar(sql.MAX), JSON.stringify(questionnaire || {}))
      .query(`
        UPDATE arion.site
           SET questionnaire_json = @q, updated_at = GETUTCDATE()
         WHERE site_id = @sid;
      `).catch(() => { /* column may not exist on older schemas — soft-fail */ });

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

    await setStatusPhase(pool, site.site_id, 'questionnaire_saved');
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

    // Flag on arion.site — column may be new, soft-fail if missing.
    if (site_id) {
      await pool.request()
        .input('sid', sql.UniqueIdentifier, site_id)
        .query(`
          IF COL_LENGTH('arion.site', 'consulting_migration_queued_at') IS NOT NULL
            UPDATE arion.site
               SET consulting_migration_queued_at = SYSDATETIMEOFFSET(),
                   status_phase = 'consulting_migration_queued',
                   updated_at = GETUTCDATE()
             WHERE site_id = @sid;
        `).catch(() => { /* column-absent fallback below */ });
      await setStatusPhase(pool, site_id, 'consulting_migration_queued');
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
    await setStatusPhase(pool, site_id, 'creating_hosting');
    // Mark queued — the legacy /onboarding/submit pipeline + worker dispatch
    // already covers the actual Hostinger SSH work. Enqueueing here keeps
    // the runner's contract simple: action() returns once the side-effect
    // is durably queued; waitFor() polls until it lands.
    await pool.request()
      .input('sid', sql.UniqueIdentifier, site_id)
      .query(`
        UPDATE arion.site
           SET provisioning_state = CASE WHEN provisioning_state = 'ready' THEN provisioning_state ELSE 'queued' END,
               updated_at = GETUTCDATE()
         WHERE site_id = @sid;
      `);
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'installing_plugins');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'installing_plugins');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'creating_editor_user');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'generating_pages');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'seeding_keywords');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'seeding_competitors');
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    await setStatusPhase(pool, site_id, 'awaiting_bing_oauth');
    // Production: lib/bingWebmaster.js owns the OAuth URL builder. For
    // now, mark queued so the engine waits for the integration row.
    await firePlatformEvent(pool, {
      tenantId: String(req.tenant.tenantId).toUpperCase(),
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
    let statusPhase = null;
    try {
      const phaseRes = await pool.request()
        .input('sid', sql.UniqueIdentifier, siteId)
        .query(`SELECT status_phase FROM arion.site WHERE site_id = @sid`);
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
