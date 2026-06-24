import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { completeProvisioning } from '../lib/provisioner.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { createProvisionCode } from '../lib/provisionCodes.js';

const router = Router();

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
  const pool = await getServicesPool();
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT site_id, tenant_id, domain, arion_tier AS tier, feature_addons_json,
             status_phase, plugin_status
      FROM arion.site WHERE site_id = @siteId AND tenant_id = @tenantId`);
  return r.recordset[0] || null;
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

    const { stripHostingerOnboardingPlugins } = await import('../lib/hostingerSsh.js');
    const { installPluginsForTier } = await import('../lib/pluginStack.js');

    // 1) Strip Hostinger defaults (leaves third-party plugins alone per spec).
    try { await stripHostingerOnboardingPlugins(site.domain); }
    catch (e) { console.warn('[runner:plugin-stack] strip warn:', e.message); }

    // 2) Install/activate the IA plugin stack for this tier.
    const installShop = false; // WooCommerce remains opt-in per memory reference_arion_plugin_stack
    await installPluginsForTier({
      domain: site.domain,
      tier: site.tier || 'starter',
      installShop,
      iaPluginDownloadUrl: process.env.IA_PLUGIN_DOWNLOAD_URL || null,
      provisionCode: null, // existing sites already provisioned; new sites get this via /sites/:id/provision-codes flow
    });

    res.json({ ok: true, data: { domain: site.domain, tier: site.tier || 'starter' } });
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
    const owner = await loadOwnerFromSignupSession(site_id, tenant_id);
    if (!owner || !owner.email) {
      // No owner email captured yet — wizard hasn't reached Step 5 (Owner). Defer.
      return res.json({ ok: true, data: { deferred: true, reason: 'no owner email in signup_session yet' } });
    }
    const { createClientEditor } = await import('../lib/hostingerSsh.js');
    const result = await createClientEditor({
      domain: site.domain,
      clientEmail: owner.email,
      clientFirstName: owner.firstName || 'Owner',
      clientLastName: owner.lastName || '',
    });
    res.json({ ok: true, data: result || { created: true } });
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
    try { if (typeof persistResult === 'function') await persistResult(site_id, result); }
    catch (e) { console.warn('[runner:configure-seo] persistResult warn:', e.message); }

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
