/**
 * Provisioning Routes — Plugin Bootstrap Lifecycle
 * --------------------------------------------------------------------------
 * Used by the IA Plugin's bootstrap class on a freshly-provisioned client site.
 * Called in this order after the Hostinger AI Builder finishes:
 *
 *   POST /provisioning/manifest      — fetch install instructions
 *   POST /provisioning/site-ready    — report completion
 *
 * Both endpoints authenticate via the one-time provisioning code that was
 * seeded into wp_options before the plugin activated. The code is stored as
 * a SHA-256 hash on our side; the plugin sends it in cleartext over HTTPS.
 *
 * The manifest endpoint redeems the code (single-use) and returns the JSON
 * manifest produced by lib/manifestBuilder.js.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { hashSiteToken } from '../lib/siteToken.js';
import { buildManifest } from '../lib/manifestBuilder.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { transitionState, getJob } from '../lib/provisioningJobs.js';
import { sendEmail } from '../lib/email.js';
import { siteReadyEmail, portalAccountInviteEmail } from '../lib/emailTemplates.js';
import { createPortalUser } from '../lib/entraExternalId.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /manifest
// Authentication: Bearer <site_token> (Authorization header)
// Body: { site_url: "https://client.com" }
// Returns: provisioning manifest JSON
//
// The provisioning code has already been redeemed by the existing
// /public/provision-codes/redeem flow at this point — that flow generated
// the site_token the plugin uses here. This endpoint is idempotent: the
// bootstrap can fetch its manifest multiple times if it needs to retry.
// ---------------------------------------------------------------------------
router.post('/manifest', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bearer site_token required', status: 401 } });
  }
  const siteToken = m[1].trim();
  const tokenHash = hashSiteToken(siteToken);
  const siteUrl = String(req.body?.site_url || '').trim();

  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'site_url must be a full URL', status: 400 },
    });
  }

  try {
    const pool = await getServicesPool();

    // Resolve site by token hash
    const tokenLookup = await pool.request()
      .input('tokenHash', sql.NVarChar(64), tokenHash)
      .query(`SELECT TOP 1 tenant_id, site_id FROM arion.site WHERE site_token_hash = @tokenHash`);

    if (tokenLookup.recordset.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'site_token not recognized', status: 401 } });
    }
    const { tenant_id, site_id } = tokenLookup.recordset[0];

    // Look up site context for tier + branding
    const siteRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('siteId', sql.UniqueIdentifier, site_id)
      .query(`
        SELECT TOP 1
          s.tier,
          s.branding_primary_color,
          s.branding_logo_url,
          s.branding_font_family,
          s.feature_addons_json
        FROM arion.site s
        WHERE s.tenant_id = @tenantId AND s.site_id = @siteId
      `);

    const row = siteRow.recordset[0] || {};
    const featureAddons = row.feature_addons_json
      ? safeParseArray(row.feature_addons_json)
      : [];

    const manifest = buildManifest({
      tenantId: tenant_id,
      siteId: site_id,
      tier: row.tier || 'starter',
      branding: {
        primaryColor: row.branding_primary_color || null,
        logoUrl: row.branding_logo_url || null,
        fontFamily: row.branding_font_family || null,
      },
      featureAddons,
      // The site_token authenticates future callbacks (site-ready). The
      // provisioning code itself was consumed at redeem time and is no longer
      // valid. We pass an empty string here for backwards compat with the
      // manifest schema; the plugin uses its stored site_token instead.
      provisionCode: '',
    });

    // Mark the site as "manifest_fetched" so the UI can show progress
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('siteId', sql.UniqueIdentifier, site_id)
      .input('siteUrl', sql.NVarChar(500), siteUrl)
      .query(`
        UPDATE arion.site
        SET provisioning_state = 'manifest_fetched',
            wp_admin_url = COALESCE(wp_admin_url, @siteUrl + '/wp-admin/'),
            updated_at = GETUTCDATE()
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);

    return res.json({ data: manifest, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[provisioning/manifest]', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /site-ready
// Authentication: Bearer <site_token>
// Body: { status: "ok"|"partial"|"failed", details: {...} }
// Reports completion of plugin bootstrap.
// ---------------------------------------------------------------------------
router.post('/site-ready', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bearer site_token required', status: 401 } });
  }
  const siteToken = m[1].trim();
  const tokenHash = hashSiteToken(siteToken);

  const status = String(req.body?.status || '').toLowerCase().trim();
  const details = req.body?.details || {};

  if (!['ok', 'partial', 'failed'].includes(status)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'status must be ok|partial|failed', status: 400 },
    });
  }

  try {
    const pool = await getServicesPool();

    const tokenLookup = await pool.request()
      .input('tokenHash', sql.NVarChar(64), tokenHash)
      .query(`SELECT TOP 1 tenant_id, site_id FROM arion.site WHERE site_token_hash = @tokenHash`);

    if (tokenLookup.recordset.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'site_token not recognized', status: 401 } });
    }
    const { tenant_id, site_id } = tokenLookup.recordset[0];

    const provisioningState = status === 'ok' ? 'ready'
                            : status === 'partial' ? 'ready_partial'
                            : 'failed';

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('siteId', sql.UniqueIdentifier, site_id)
      .input('state', sql.NVarChar(40), provisioningState)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details).slice(0, 8000))
      .query(`
        UPDATE arion.site
        SET provisioning_state = @state,
            provisioning_details_json = @details,
            provisioned_at = CASE WHEN provisioned_at IS NULL THEN GETUTCDATE() ELSE provisioned_at END,
            updated_at = GETUTCDATE()
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);

    // Fire site-ready email + tier-gated integration kickoff (best-effort, non-blocking)
    if (status === 'ok' || status === 'partial') {
      sendSiteReadyNotification(pool, { tenant_id, site_id, partial: status === 'partial' })
        .catch((err) => console.warn('[provisioning/site-ready] notification failed:', err.message));

      // Tier-gated integrations (GA4, GSC, Bing Webmaster, SE Ranking project)
      kickoffTierIntegrations(pool, { tenant_id, site_id })
        .catch((err) => console.warn('[provisioning/site-ready] integration kickoff failed:', err.message));
    }

    // Fire platform event so downstream services (analytics, billing, etc.)
    // know the site is live.
    await firePlatformEvent(pool, {
      tenantId: tenant_id,
      eventType: status === 'ok' ? 'arion.site.provisioned' : 'arion.site.provisioning_partial',
      eventRefId: site_id,
      payload: { site_id, status, details },
    }).catch((err) => console.warn('[provisioning/site-ready] platform event failed:', err.message));

    return res.json({ data: { site_id, state: provisioningState }, meta: { timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[provisioning/site-ready]', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /worker-progress
// Called by the Playwright worker to report phase transitions.
// Body: { jobId, state, details: { error?, screenshot_b64?, ...} }
//
// Auth: shared secret in `x-worker-secret` header. Both arion-api and the
// worker container have PROVISIONER_SHARED_SECRET set to the same value.
// ---------------------------------------------------------------------------
router.post('/worker-progress', async (req, res) => {
  const expected = process.env.PROVISIONER_SHARED_SECRET || '';
  if (expected && req.headers['x-worker-secret'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { jobId, state, details = {} } = req.body || {};
  if (!jobId || !state) {
    return res.status(400).json({ error: 'jobId + state required' });
  }

  try {
    const pool = await getServicesPool();
    const job = await getJob(pool, jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });

    await transitionState(pool, jobId, state, {
      message: details.message || null,
      error: details.error || null,
      screenshotB64: details.screenshot_b64 || null,
    });

    // Mirror state to arion.site so other parts of the app (status route, dashboards) see it.
    let siteState = null;
    if (state === 'completed') siteState = 'ai_builder_done';
    else if (state === 'started') siteState = 'ai_builder_running';
    else if (state === 'plugin_deploy') siteState = 'plugin_deploying';
    else if (state === 'auto_redeem_trigger') siteState = 'awaiting_bootstrap';
    else if (state === 'failed') siteState = 'failed';
    if (siteState) {
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, job.site_id)
        .input('state', sql.NVarChar(40), siteState)
        .query(`UPDATE arion.site SET provisioning_state = @state, updated_at = GETUTCDATE() WHERE site_id = @siteId`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[provisioning/worker-progress]', err);
    return res.status(500).json({ error: err.message });
  }
});

function safeParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Send the "your site is live" email. Looks up the tenant's primary email
 * and the new site's domain + WP login URL, then fires a templated email.
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} args
 * @param {string} args.tenant_id
 * @param {string} args.site_id
 * @param {boolean} args.partial - true if the bootstrap reported "partial"
 */
async function sendSiteReadyNotification(pool, { tenant_id, site_id, partial }) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenant_id)
    .input('siteId', sql.UniqueIdentifier, site_id)
    .query(`
      SELECT TOP 1 t.primary_email, t.entra_user_id, s.domain, s.wp_admin_url
      FROM arion.tenant t
      JOIN arion.site s ON s.tenant_id = t.tenant_id
      WHERE t.tenant_id = @tenantId AND s.site_id = @siteId
    `);
  const row = r.recordset[0];
  if (!row?.primary_email || !row?.domain) return;

  const wpLoginUrl = row.wp_admin_url
    ? String(row.wp_admin_url).replace(/\/+$/, '').replace(/\/wp-admin$/, '') + '/wp-login.php'
    : `https://${row.domain}/wp-login.php`;

  // 1. "Site is live" email
  const tpl = siteReadyEmail({
    firstName: '',
    domain: row.domain,
    wpLoginUrl,
    portalUrl: null,
    partial: !!partial,
  });
  await sendEmail({
    to: row.primary_email,
    subject: tpl.subject,
    html: tpl.html,
    tag: partial ? 'site_ready_partial' : 'site_ready',
    metadata: { tenant_id, site_id, domain: row.domain },
  });

  // 2. Portal account invite — only if we haven't already created one
  if (!row.entra_user_id) {
    try {
      const userRes = await createPortalUser({
        email: row.primary_email,
        displayName: row.primary_email,
      });
      if (userRes.ok) {
        // Persist the Entra user ID so we don't re-create on retries
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenant_id)
          .input('userId', sql.NVarChar(80), userRes.userId)
          .query(`UPDATE arion.tenant SET entra_user_id = @userId, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId`);

        // Email them the temp credentials
        if (userRes.tempPassword) {
          const inviteUrl = process.env.IADM_PORTAL_SIGNIN_URL || (process.env.PORTAL_URL || 'https://portal.intelligentanalyticsdm.com');
          const inviteTpl = portalAccountInviteEmail({
            firstName: '',
            email: row.primary_email,
            inviteRedeemUrl: inviteUrl,
          });
          await sendEmail({
            to: row.primary_email,
            subject: inviteTpl.subject,
            // Attach temp password to the body — it's a forced-change credential
            html: inviteTpl.html.replace(
              '</td></tr>',
              `<p style="margin:16px 0 0;font-size:13px;color:#374151;background:#f3f4f6;padding:10px;border-radius:6px;">Temporary password: <code style="font-family:monospace;">${escapeForHtml(userRes.tempPassword)}</code><br/><span style="color:#6b7280;">You'll be asked to change this on first sign-in.</span></p></td></tr>`
            ),
            tag: 'portal_account_invite',
            metadata: { tenant_id, user_id: userRes.userId },
          });
        }
      } else {
        console.warn('[provisioning/site-ready] createPortalUser failed:', userRes.error);
      }
    } catch (err) {
      console.warn('[provisioning/site-ready] portal user invite error:', err.message);
    }
  }
}

function escapeForHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fire tier-gated integration setup. Each integration runs independently and
 * non-blocking — the site is "ready" regardless of whether GA4/GSC/etc.
 * provisioning succeeds. Failures surface in the dashboard's Integrations
 * panel where the client can retry.
 */
async function kickoffTierIntegrations(pool, { tenant_id, site_id }) {
  const { default: kickoffModule } = await import('../lib/integrationKickoff.js');
  await kickoffModule.runForSite(pool, { tenantId: tenant_id, siteId: site_id });
}

export default router;
