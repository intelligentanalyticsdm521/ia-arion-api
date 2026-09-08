import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { completeProvisioning } from '../lib/provisioner.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { createProvisionCode } from '../lib/provisionCodes.js';

const router = Router();

// Public API base used to construct per-tenant plugin-download token URLs
// (same pattern as routes/onboarding/submit.js + routes/admin/onboardExisting.js).
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

// Simple key check for internal endpoints
function requireIngestKey(req, res, next) {
  const key = process.env.ARION_INGEST_KEY;
  if (!key) return next(); // Skip if no key configured
  const provided = req.headers['x-arion-ingest-key'];
  if (provided !== key) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid ingest key', status: 401 } });
  }
  next();
}

router.get('/status', (req, res) => {
  res.json({ status: 'ok', service: 'arion-api', timestamp: new Date().toISOString() });
});

// POST /internal/gbp-auto-reply-tick — Pro+ auto-reply run, triggered by the
// arion-func timer. Drafts (metered) + posts replies to unreplied reviews
// for opted-in sites. Idempotent; capped per site.
router.post('/gbp-auto-reply-tick', requireIngestKey, async (req, res) => {
  try {
    const pool = await getServicesPool();
    const { runGbpAutoReplyTick } = await import('../lib/gbpAutoReplyRunner.js');
    const summary = await runGbpAutoReplyTick(pool, (m) => console.log(`[gbp-auto-reply] ${m}`));
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[internal:gbp-auto-reply-tick]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /internal/content-agent-tick — the ARION Content & Social Agent weekly
// cycle, triggered by the arion-func timer (same split as gbp-auto-reply-tick:
// logic here, scheduling there). Runs every enabled, un-halted tenant from
// arion.content_agent_tenant_config; one tenant's failure never costs
// another's cycle. Closes with the 60% margin report, and every alert it
// raises leaves through the ONE notification gate with a category_key.
//
// KILL SWITCH: CONTENT_AGENT_DISABLED is honoured inside runTick, so it stops
// this endpoint too and not merely the timer that normally calls it. A
// disabled tick reads no config, drafts nothing and queues nothing, and says
// so in the response.
//
// AUTH: requireIngestKey, the same internal-token gate the other two ticks use
// (x-arion-ingest-key, set on the Functions app as ARION_INGEST_KEY).
router.post('/content-agent-tick', requireIngestKey, async (req, res) => {
  try {
    const pool = await getServicesPool();
    const { runTick } = await import('../lib/contentAgent/tick.js');
    const summary = await runTick({ pool, log: (m) => console.log(`[content-agent] ${m}`) });
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[internal:content-agent-tick]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /internal/insights-snapshot-tick — monthly IA Insights refresh,
// triggered by the arion-func timer on the 1st (same thin-scheduler split as
// gbp-auto-reply-tick). Aggregates SE Ranking position history + pulls the
// last 2 months of GSC/GA4/GBP into arion.metric_monthly. MERGE-idempotent.
router.post('/insights-snapshot-tick', requireIngestKey, async (req, res) => {
  try {
    const pool = await getServicesPool();
    const { runFullInsightsSnapshot } = await import('../lib/insightsSnapshot.js');
    const summary = await runFullInsightsSnapshot(pool, (m) => console.log(`[insights-snapshot] ${m}`));
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[internal:insights-snapshot-tick]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /internal/sites/:siteId/complete-provisioning
// Called by admin after manual Golden Master setup is done
router.post('/sites/:siteId/complete-provisioning', requireIngestKey, async (req, res) => {
  const { siteId } = req.params;
  const { tenant_id, wp_admin_url, domain, ssl_expiry } = req.body;

  if (!tenant_id || !wp_admin_url) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'tenant_id and wp_admin_url are required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();
    const result = await completeProvisioning(pool, siteId, tenant_id, { wp_admin_url, domain, ssl_expiry });

    // Fire provisioning complete event
    await firePlatformEvent(pool, {
      tenantId: tenant_id,
      eventType: 'arion.site.provisioned',
      eventRefId: siteId,
      payload: { site_id: siteId, wp_admin_url, domain, status: 'active' }
    });

    res.json({ data: { site_id: siteId, ...result }, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[internal:complete-provisioning]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /internal/sites/:siteId/rotate-token
// Rotate a site's plugin token
router.post('/sites/:siteId/rotate-token', requireIngestKey, async (req, res) => {
  const { siteId } = req.params;
  const { tenant_id } = req.body;
  if (!tenant_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'tenant_id required', status: 400 } });

  try {
    const { generateSiteToken, hashSiteToken } = await import('../lib/siteToken.js');
    const pool = await getServicesPool();
    const newToken = generateSiteToken();
    const newHash = hashSiteToken(newToken);

    const result = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('tokenHash', sql.NVarChar(64), newHash)
      .query(`
        UPDATE arion.site
        SET site_token_hash = @tokenHash, site_token_last_rotated = SYSDATETIMEOFFSET(), updated_at = SYSDATETIMEOFFSET()
        WHERE site_id = @siteId AND tenant_id = @tenantId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }

    res.json({ data: { site_id: siteId, site_token: newToken, rotated_at: new Date().toISOString() }, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[internal:rotate-token]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /internal/sites/:siteId/provision-codes
// Create a one-time provisioning code that the IA Plugin can redeem to
// auto-configure itself (site_id, tenant_id, site_token, tier, seo_addon).
// Body: { tenant_id, created_by?, ttl_days? }
router.post('/sites/:siteId/provision-codes', requireIngestKey, async (req, res) => {
  const { siteId } = req.params;
  const { tenant_id, created_by, ttl_days } = req.body;
  if (!tenant_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'tenant_id required', status: 400 } });

  try {
    const pool = await getServicesPool();

    // Verify site exists
    const siteResult = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .query('SELECT site_id FROM arion.site WHERE site_id = @siteId AND tenant_id = @tenantId');
    if (siteResult.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found for tenant', status: 404 } });
    }

    const result = await createProvisionCode(pool, {
      tenantId: tenant_id,
      siteId,
      createdBy: created_by || null,
      ttlDays: Number(ttl_days) > 0 ? Number(ttl_days) : 7,
    });

    res.json({
      data: {
        code: result.code,          // raw code — returned ONLY here, never persisted
        code_id: result.code_id,
        expires_at: result.expires_at,
        site_id: siteId,
        tenant_id,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[internal:provision-codes:create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /internal/sites/:siteId/provision-codes — list non-redeemed codes (admin)
router.get('/sites/:siteId/provision-codes', requireIngestKey, async (req, res) => {
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT code_id, created_by, created_at, expires_at, redeemed_at, redeemed_from_url, revoked_at, revoked_reason
        FROM arion.site_provision_code
        WHERE site_id = @siteId
        ORDER BY created_at DESC
      `);
    res.json({ data: { codes: result.recordset }, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[internal:provision-codes:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// DELETE /internal/sites/:siteId/provision-codes/:codeId — revoke
router.delete('/sites/:siteId/provision-codes/:codeId', requireIngestKey, async (req, res) => {
  const { siteId, codeId } = req.params;
  const { reason } = req.body || {};
  try {
    const pool = await getServicesPool();
    await pool.request()
      .input('codeId', sql.UniqueIdentifier, codeId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('reason', sql.NVarChar(500), reason || 'admin_revoked')
      .query(`
        UPDATE arion.site_provision_code
        SET revoked_at = SYSDATETIMEOFFSET(), revoked_reason = @reason
        WHERE code_id = @codeId AND site_id = @siteId AND redeemed_at IS NULL AND revoked_at IS NULL
      `);
    res.json({ data: { revoked: true }, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[internal:provision-codes:delete]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* =========================================================================
 * OnboardingRunner advance endpoints (called by arion-func worker)
 *
 * The worker (arion-func src/shared/onboardingRunner.js) sits on the
 * arion.site rows in status_phase IN (installing_plugins, creating_editor_user,
 * configuring_seo, connecting_bing) and calls these handlers every 30s. Each
 * handler runs ONE side-effect, returns 200 { ok: true } on success, and the
 * worker then transitions the row to the next phase. On 4xx { retryable }
 * the worker leaves the row in place and retries. On 404 the worker logs
 * "deferred — endpoint not deployed yet" (the state before THIS commit).
 *
 * Contract (matches arion-func/src/shared/onboardingRunner.js:418):
 *   POST /internal/runner/advance/{kind}
 *   Headers: x-arion-ingest-key
 *   Body:    { tenant_id, site_id, domain }
 *   Response: 200 { ok: true, data? } | 4xx { ok: false, error, retryable }
 *
 * Brandon 2026-06-23 — built so the founder wizard runner can actually
 * advance phase-by-phase instead of stalling at "Installing your tools".
 * ========================================================================= */

async function loadSiteRow(siteId, tenantId) {
  // ARION schema owns ONLY product-specific site data — never contact info.
  // Owner contact is sourced separately from arion.signup_session (transient
  // wizard data) by handlers that need it. See memory:
  // reference_data_ownership_architecture.
  //
  // 2026-07-16 — se_ranking_project_id was NOT in this SELECT, and that omission
  // was a MONEY bug, not a cosmetic one.
  //
  // configureForTier (lib/seoOnboarding.js:270) reads
  //     let projectId = site.se_ranking_project_id || null;
  // to decide whether this site already has an SE Ranking project. With the
  // column absent here it was always undefined, so :271's `if (!projectId)` was
  // ALWAYS true and it created a BRAND NEW, BILLABLE project every time the
  // runner reached configure-seo — even for a site that already had one. The
  // idempotency guard was not weak; it was blind.
  //
  // SE Ranking bills by keywords tracked, so a duplicate project is a duplicate
  // bill, forever, silently. A real orphan existed: project 4537010
  // (shimsremodeling.com) was billing 220 keywords on daily checks for a
  // cancelled client, with no arion.site row pointing at it. Deleted 2026-07-16.
  const pool = await getServicesPool();
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT site_id, tenant_id, domain, arion_tier AS tier, feature_addons_json,
             status_phase, plugin_status,
             hostinger_website_id, hostinger_subscription_id, provisioning_state,
             se_ranking_project_id
      FROM arion.site WHERE site_id = @siteId AND tenant_id = @tenantId`);
  return r.recordset[0] || null;
}

/**
 * Persist a soft-skip reason onto arion.site.provisioning_details_json without
 * marking the row failed. Mirrors arion-func onboardingRunner.noteSoftSkip so
 * the founder dashboard surfaces these as "manual follow-up".
 */
async function noteSiteSoftSkip(siteId, key, message) {
  try {
    const pool = await getServicesPool();
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('key', sql.NVarChar(60), key)
      .input('message', sql.NVarChar(500), (message || '').slice(0, 500))
      .query(`
        UPDATE arion.site
           SET provisioning_details_json = JSON_MODIFY(
                 JSON_MODIFY(
                   COALESCE(provisioning_details_json, '{}'),
                   '$.soft_skips.' + @key, @message
                 ),
                 '$.soft_skips_present', CAST(1 AS bit)
               ),
               updated_at = SYSDATETIMEOFFSET()
         WHERE site_id = @sid
      `);
  } catch (e) {
    console.warn(`[internal:noteSiteSoftSkip] site_id=${siteId} key=${key}: ${e.message}`);
  }
}

/**
 * True when the arion.site row has no real Hostinger website provisioned —
 * i.e. upstream creating_hosting / installing_wordpress phases never actually
 * ran for this site. Happens for test-seeded rows (runner walks) and for
 * sites where the founder created the row by hand. In that state SSH wp-cli
 * cannot work (no public_html directory) and the runner-advance endpoints
 * must graceful-skip rather than mark the row hard-failed.
 */
function siteHasNoHostingerInstall(site) {
  return !site?.hostinger_website_id && !site?.hostinger_subscription_id;
}

async function loadOwnerFromSignupSession(siteId, tenantId) {
  // Transient onboarding data — pulled from the LATEST signup_session row for
  // this site. The questionnaire_json blob contains owner_first_name /
  // owner_last_name (the wizard Step 5 owner capture). Returns null if no
  // session exists yet (e.g. Path B founder wizard hasn't reached owner step).
  const pool = await getServicesPool();
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1
        email,
        JSON_VALUE(questionnaire_json, '$.owner_first_name')   AS owner_first_name,
        JSON_VALUE(questionnaire_json, '$.owner_last_name')    AS owner_last_name,
        JSON_VALUE(questionnaire_json, '$.owner_email')        AS owner_email_from_json
      FROM arion.signup_session
      WHERE site_id = @siteId AND tenant_id = @tenantId
      ORDER BY COALESCE(submitted_at, questionnaire_submitted_at, created_at) DESC`);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    email: row.owner_email_from_json || row.email || null,
    firstName: row.owner_first_name || null,
    lastName: row.owner_last_name || null,
  };
}

function ingestErr(message, retryable = false, status = 400) {
  return { status, body: { ok: false, error: { message }, retryable } };
}

// POST /internal/runner/advance/plugin-stack
// Strip Hostinger onboarding plugins + install the IA Golden Master plugin
// stack for the site's tier. Idempotent — pluginStack.installPluginsForTier
// uses `wp plugin install --activate` which is a no-op when already present.
router.post('/runner/advance/plugin-stack', requireIngestKey, async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!tenant_id || !site_id) {
    return res.status(400).json({ ok: false, error: { message: 'tenant_id + site_id required' }, retryable: false });
  }
  try {
    const site = await loadSiteRow(site_id, tenant_id);
    if (!site) return res.status(404).json({ ok: false, error: { message: 'site not found' }, retryable: false });

    // Skip-if-already-provisioned. Mirrors the wizard-side ArionSection check
    // (SCOPE_WORKING.md:2454) so re-walks against an already-provisioned site
    // don't re-run the full wp-cli install. The plugin reports plugin_status =
    // 'connected' via heartbeat once it has a valid site_token, so this is
    // the authoritative signal. If a tier upgrade adds plugins we haven't
    // installed yet, a future enhancement can compare plugin_version against
    // the expected stack manifest — for now connected+versioned is enough to
    // exit early.
    if (site.plugin_status === 'connected' && site.plugin_version) {
      console.log(`[runner:plugin-stack] skip site_id=${site_id} already_connected plugin_version=${site.plugin_version}`);
      return res.json({ ok: true, data: { skipped: 'already_provisioned', plugin_version: site.plugin_version, domain: site.domain } });
    }

    const { stripHostingerOnboardingPlugins, checkWpInstallExists } = await import('../lib/hostingerSsh.js');
    const { installPluginsForTier } = await import('../lib/pluginStack.js');

    // Pre-flight: graceful-skip when upstream Hostinger provisioning never ran.
    // Test-seeded rows and runner walks that bypass create-hosting +
    // installing-wordpress have no public_html on the box, so wp-cli would
    // fail with `bash: cd: ... No such file or directory`. Instead of marking
    // the row failed (which strands the founder dashboard at a phase that
    // can't be retried without re-provisioning Hostinger), we soft-skip:
    // record the reason on the row and return ok:true so the worker
    // advances to the next phase. The site ends in `ready` with a
    // soft_skips_present flag the founder dashboard surfaces as
    // "manual follow-up".
    if (siteHasNoHostingerInstall(site)) {
      let wpExists = false;
      try { wpExists = await checkWpInstallExists(site.domain); }
      catch (e) { console.warn('[runner:plugin-stack] preflight ssh warn:', e.message); }
      if (!wpExists) {
        const reason = `no Hostinger website provisioned for ${site.domain}; upstream create-hosting/install-wp phases never ran`;
        await noteSiteSoftSkip(site_id, 'plugin_stack_skipped_no_wp', reason);
        console.warn(`[runner:plugin-stack] soft-skip site_id=${site_id}: ${reason}`);
        return res.json({ ok: true, data: { skipped: 'no_wp_install', reason, domain: site.domain } });
      }
    }

    // 1) Strip Hostinger defaults (leaves third-party plugins alone per spec).
    try { await stripHostingerOnboardingPlugins(site.domain); }
    catch (e) { console.warn('[runner:plugin-stack] strip warn:', e.message); }

    // 2) Mint a fresh provision code + build the per-tenant token download URL.
    // Same shape as routes/onboarding/submit.js + routes/admin/onboardExisting.js:
    // arion-api serves the .zip from /plugin/download?token=<code>, and the
    // plugin self-redeems the token on first activation to write site_token +
    // tenant_id into wp_options. For an already-provisioned site (Brandon's
    // case) the token is harmless: download still works, plugin sees existing
    // site_token, no-op. For new sites it completes provisioning.
    const pool = await getServicesPool();
    const codeResult = await createProvisionCode(pool, {
      tenantId: tenant_id,
      siteId: site_id,
      createdBy: 'runner:plugin-stack',
      ttlDays: 1,
    });
    const iaPluginDownloadUrl = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(codeResult.code)}`;

    // 3) Install/activate the IA plugin stack for this tier.
    const installShop = false; // WooCommerce remains opt-in per memory reference_arion_plugin_stack
    let stackResult = null;
    try {
      stackResult = await installPluginsForTier({
        domain: site.domain,
        tier: site.tier || 'starter',
        installShop,
        iaPluginDownloadUrl,
        provisionCode: codeResult.code,
      });
    } catch (e) {
      // installPluginsForTier raises NO_WP_INSTALL when the FIRST wp-cli hits
      // a missing public_html. Graceful-skip the same way as the pre-flight
      // branch — covers the case where loadSiteRow's hostinger_website_id is
      // populated but the actual directory is gone (e.g. Hostinger deleted
      // the subdomain, or the row was migrated from a stale environment).
      if (e.code === 'NO_WP_INSTALL' || e.noWpInstall) {
        const reason = `wp-cli reported no public_html for ${site.domain}; firstFailedSlug=${e.firstFailedSlug || 'unknown'}`;
        await noteSiteSoftSkip(site_id, 'plugin_stack_skipped_no_wp', reason);
        console.warn(`[runner:plugin-stack] soft-skip on install site_id=${site_id}: ${reason}`);
        return res.json({ ok: true, data: { skipped: 'no_wp_install', reason, domain: site.domain } });
      }
      throw e;
    }

    // R5 2026-06-24 — Surface per-plugin partial failures (license activation,
    // EWWW config, SE Ranking whitelist, RankMath setup) so the dashboard sees
    // them via provisioning_details_json.plugins_failed[]. Previously the
    // runner discarded stackResult entirely and returned ok:true even when
    // multiple post-install hooks blew up. Critical plugin failures already
    // throw inside installPluginsForTier and hit the catch above.
    if (stackResult && Array.isArray(stackResult.failed) && stackResult.failed.length > 0) {
      try {
        const pool2 = await getServicesPool();
        await pool2.request()
          .input('sid', sql.UniqueIdentifier, site_id)
          .input('failed', sql.NVarChar(sql.MAX), JSON.stringify(stackResult.failed))
          .input('installed', sql.NVarChar(sql.MAX), JSON.stringify(stackResult.installed || []))
          .query(`
            UPDATE arion.site
               SET provisioning_details_json = JSON_MODIFY(
                     JSON_MODIFY(
                       COALESCE(provisioning_details_json, '{}'),
                       '$.plugins_failed', JSON_QUERY(@failed)
                     ),
                     '$.plugins_installed', JSON_QUERY(@installed)
                   ),
                   updated_at = SYSDATETIMEOFFSET()
             WHERE site_id = @sid
          `);
      } catch (persistErr) {
        console.warn(`[runner:plugin-stack] persist failed[] write threw: ${persistErr.message}`);
      }
      console.warn(`[runner:plugin-stack] partial failures site_id=${site_id} failed=${JSON.stringify(stackResult.failed).slice(0, 300)}`);
    }

    res.json({
      ok: true,
      data: {
        domain: site.domain,
        tier: site.tier || 'starter',
        installed: stackResult?.installed || [],
        skipped: stackResult?.skipped || [],
        failed: stackResult?.failed || [],
      },
    });
  } catch (err) {
    console.error('[runner:plugin-stack]', err);
    const retryable = !/no such|not found|auth|credentials|secret/i.test(err.message || '');
    res.status(500).json({ ok: false, error: { message: err.message }, retryable });
  }
});

// POST /internal/runner/advance/create-wp-user
// Create the client's WP editor user. Idempotent — createClientEditor uses
// `wp user create` which is safe to call (returns "username is already
// registered" or "email is already used" which we treat as already-done).
router.post('/runner/advance/create-wp-user', requireIngestKey, async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!tenant_id || !site_id) {
    return res.status(400).json({ ok: false, error: { message: 'tenant_id + site_id required' }, retryable: false });
  }
  try {
    const site = await loadSiteRow(site_id, tenant_id);
    if (!site) return res.status(404).json({ ok: false, error: { message: 'site not found' }, retryable: false });

    const { createClientEditor, checkWpInstallExists } = await import('../lib/hostingerSsh.js');

    // Pre-flight: same graceful-skip rule as plugin-stack — no public_html →
    // can't wp-cli, can't fail. Soft-skip + advance so the walk completes.
    if (siteHasNoHostingerInstall(site)) {
      let wpExists = false;
      try { wpExists = await checkWpInstallExists(site.domain); }
      catch (e) { console.warn('[runner:create-wp-user] preflight ssh warn:', e.message); }
      if (!wpExists) {
        const reason = `no Hostinger website provisioned for ${site.domain}; cannot create wp-admin user`;
        await noteSiteSoftSkip(site_id, 'create_wp_user_skipped_no_wp', reason);
        console.warn(`[runner:create-wp-user] soft-skip site_id=${site_id}: ${reason}`);
        return res.json({ ok: true, data: { skipped: 'no_wp_install', reason, domain: site.domain } });
      }
    }

    const owner = await loadOwnerFromSignupSession(site_id, tenant_id);
    if (!owner || !owner.email) {
      // No owner email captured yet — wizard hasn't reached Step 5 (Owner). Defer.
      return res.json({ ok: true, data: { deferred: true, reason: 'no owner email in signup_session yet' } });
    }
    try {
      const result = await createClientEditor({
        domain: site.domain,
        clientEmail: owner.email,
        clientFirstName: owner.firstName || 'Owner',
        clientLastName: owner.lastName || '',
      });
      res.json({ ok: true, data: result || { created: true } });
    } catch (e) {
      if (e.code === 'NO_WP_INSTALL' || e.noWpInstall) {
        const reason = `wp-cli reported no public_html for ${site.domain}`;
        await noteSiteSoftSkip(site_id, 'create_wp_user_skipped_no_wp', reason);
        console.warn(`[runner:create-wp-user] soft-skip on call site_id=${site_id}: ${reason}`);
        return res.json({ ok: true, data: { skipped: 'no_wp_install', reason, domain: site.domain } });
      }
      throw e;
    }
  } catch (err) {
    console.error('[runner:create-wp-user]', err);
    const msg = err.message || '';
    // wp-cli idempotent error cases — treat as success.
    if (/already registered|already used|already exists/i.test(msg)) {
      return res.json({ ok: true, data: { already_exists: true } });
    }
    const retryable = !/no such|credentials|secret|invalid email/i.test(msg);
    res.status(500).json({ ok: false, error: { message: msg }, retryable });
  }
});

// POST /internal/runner/advance/configure-seo
// SE Ranking project + keyword seed + competitor seed + tier-specific config.
// Only fires when the runner determined this site has the SEO add-on
// (Growth/Authority tier or feature_addons_json.arion_seo true).
router.post('/runner/advance/configure-seo', requireIngestKey, async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!tenant_id || !site_id) {
    return res.status(400).json({ ok: false, error: { message: 'tenant_id + site_id required' }, retryable: false });
  }
  try {
    const site = await loadSiteRow(site_id, tenant_id);
    if (!site) return res.status(404).json({ ok: false, error: { message: 'site not found' }, retryable: false });

    const { configureForTier, persistResult } = await import('../lib/seoOnboarding.js');
    const result = await configureForTier(site, site.tier || 'starter');

    // persistResult is declared persistResult(pool, tenantId, siteId, result) —
    // FOUR arguments. It was called with TWO: persistResult(site_id, result).
    // So `pool` was a site_id string, `pool.request()` threw a TypeError, the
    // catch swallowed it, and the route still returned ok:true.
    //
    // Net effect: configureForTier (above) had ALREADY created a billable SE
    // Ranking project, and then we failed to record its id — so the next run
    // couldn't know it existed and would create another one. Combined with
    // loadSiteRow not selecting se_ranking_project_id (fixed above), that is a
    // duplicate paid project on every pass, silently.
    //
    // 🪤 Fixing ONLY the arity would have been WORSE than the bug: the guard
    // would still be blind, so it would still create the duplicate — and now
    // successfully SAVE it, overwriting the real project id. Both halves or
    // neither. (Third time this shape has appeared: the campaign_recipient
    // INSERT needed the NOT NULL too, and suppression_list needed `domain`
    // relaxed, not just `email` added.)
    //
    // Still guarded: a failure to record must not fail the runner step, because
    // the project was created and re-running is safe now that the guard works.
    // But it is an ERROR, not a warning — an unrecorded project id is exactly
    // how an orphan is born (see project 4537010, shimsremodeling.com: a real
    // orphan billing 220 keywords daily for a cancelled client, deleted
    // 2026-07-16).
    try {
      if (typeof persistResult === 'function') {
        // loadSiteRow opens its own pool internally, so this scope has none —
        // getServicesPool() is cached, so this is a lookup, not a new connection.
        const pool = await getServicesPool();
        await persistResult(pool, tenant_id, site_id, result);
      }
    } catch (e) {
      console.error('[runner:configure-seo] persistResult FAILED — project id not recorded, this creates an orphan:', e.message);
    }

    res.json({ ok: true, data: result || { configured: true } });
  } catch (err) {
    console.error('[runner:configure-seo]', err);
    const msg = err.message || '';
    const retryable = !/SE_RANKING.*not.*configured|api.*key.*missing|secret/i.test(msg);
    res.status(retryable ? 500 : 400).json({ ok: false, error: { message: msg }, retryable });
  }
});

// POST /internal/runner/advance/bing-auto-connect
// Auto-add the site to our master Bing Webmaster account so we start
// collecting Bing search data without user intervention. The BYO Bing
// path is handled separately (user OAuths their own Bing account).
router.post('/runner/advance/bing-auto-connect', requireIngestKey, async (req, res) => {
  const { tenant_id, site_id } = req.body || {};
  if (!tenant_id || !site_id) {
    return res.status(400).json({ ok: false, error: { message: 'tenant_id + site_id required' }, retryable: false });
  }
  try {
    const site = await loadSiteRow(site_id, tenant_id);
    if (!site) return res.status(404).json({ ok: false, error: { message: 'site not found' }, retryable: false });

    const masterKey = process.env.BING_WMT_API_KEY || process.env['BING-WMT-API-KEY'];
    if (!masterKey) {
      // Founder hasn't pasted the IA master Bing key yet — non-retryable.
      // Worker should mark as failed_user_action so founder sees the gap.
      return res.status(503).json({ ok: false, error: { message: 'BING-WMT-API-KEY not configured in KV' }, retryable: false });
    }

    const { addSite, getSiteEntry } = await import('../lib/bingWebmaster.js');
    const siteUrl = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
    try { await addSite(masterKey, siteUrl); }
    catch (e) {
      // Bing returns various "already added" shapes — log + check entry.
      console.warn('[runner:bing-auto-connect] addSite warn:', e.message);
    }
    const entry = await getSiteEntry(masterKey, siteUrl);

    // Persist state so the integrations-status endpoint reflects it.
    const pool = await getServicesPool();
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, site_id)
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('mode', sql.NVarChar(20), 'auto_ia')
      .query(`UPDATE arion.site
              SET bing_setup_mode = @mode,
                  bing_connected = CASE WHEN bing_connected = 1 THEN 1 ELSE 1 END,
                  bing_setup_probed_at = SYSDATETIMEOFFSET(),
                  updated_at = SYSDATETIMEOFFSET()
              WHERE site_id = @siteId AND tenant_id = @tenantId`);

    res.json({ ok: true, data: { added: !!entry, siteUrl } });
  } catch (err) {
    console.error('[runner:bing-auto-connect]', err);
    const retryable = !/api.*key.*missing|secret|invalid url/i.test(err.message || '');
    res.status(retryable ? 500 : 400).json({ ok: false, error: { message: err.message }, retryable });
  }
});

export default router;
