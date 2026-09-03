// SSO launch-token verify endpoint — called by the IA WordPress plugin
// when a user clicks "WP Admin" in the Portal. The plugin sends the
// short-lived launch token (minted by GET /arion/sites/:id/admin-link)
// + its X-Arion-Site-Token. We validate the pair, mark the launch token
// redeemed, and return the Portal user's email so the plugin can
// wp_set_auth_cookie() the matching WP user.
//
// 2026-06-29 — Extracted from routes/arion.js so it can be mounted
// at /arion/sso BEFORE the global requireAuth middleware that fronts
// /arion/* with Bearer-required auth. Plugin auth is X-Arion-Site-Token,
// not Bearer, so the route can't live inside the requireAuth namespace.

import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';

const router = Router();

// POST /verify (mounted at /arion/sso → final URL /arion/sso/verify)
router.post('/verify', async (req, res) => {
  try {
    const siteToken =
      req.headers['x-arion-site-token']
      || req.headers['x-site-token']
      || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
      || null;
    if (!siteToken) {
      return res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Site token required', status: 401 } });
    }
    const siteTokenHash = crypto.createHash('sha256').update(siteToken).digest('hex');

    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: { code: 'MISSING_LAUNCH_TOKEN', message: 'token required in body', status: 400 } });
    }
    const launchTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const pool = await getServicesPool();

    const siteRes = await pool.request()
      .input('siteTokenHash', sql.NVarChar(128), siteTokenHash)
      .query(`SELECT site_id, tenant_id, domain FROM arion.site WHERE site_token_hash = @siteTokenHash`);
    if (siteRes.recordset.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_SITE_TOKEN', message: 'Site token not recognised', status: 401 } });
    }
    const site = siteRes.recordset[0];

    const ltRes = await pool.request()
      .input('hash', sql.NVarChar(128), launchTokenHash)
      .query(`
        SELECT token_id, site_id, tenant_id, portal_user_email, expires_at, redeemed_at
        FROM arion.sso_launch_token
        WHERE token_hash = @hash
      `);
    if (ltRes.recordset.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Launch token not found', status: 404 } });
    }
    const lt = ltRes.recordset[0];

    if (String(lt.site_id).toLowerCase() !== String(site.site_id).toLowerCase()) {
      return res.status(403).json({ ok: false, error: { code: 'SITE_MISMATCH', message: 'Token does not belong to this site', status: 403 } });
    }
    if (lt.redeemed_at) {
      return res.status(410).json({ ok: false, error: { code: 'ALREADY_REDEEMED', message: 'Launch token already used', status: 410 } });
    }
    if (new Date(lt.expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: { code: 'EXPIRED', message: 'Launch token expired', status: 410 } });
    }

    await pool.request()
      .input('tokenId', sql.UniqueIdentifier, lt.token_id)
      .input('ip', sql.NVarChar(64), (req.ip || '').slice(0, 64))
      .query(`UPDATE arion.sso_launch_token
              SET redeemed_at = SYSDATETIMEOFFSET(), redeemed_user_ip = @ip
              WHERE token_id = @tokenId AND redeemed_at IS NULL`);

    // 2026-08-24 SECURITY — tell the plugin whether the `iaadmin` ADMINISTRATOR
    // fallback is permitted for this caller.
    //
    // The plugin resolves the WP user by email and, when there is no match,
    // has been falling back to `iaadmin` and wp_set_auth_cookie()-ing the
    // caller in as an ADMINISTRATOR (intelligent-analytics.php:81-84, :97).
    // Since a88c4c0 (2026-08-17) clients are deliberately provisioned as WP
    // `editor` so they cannot install plugins, change themes or manage users —
    // and this fallback handed exactly those powers to anyone on an
    // ARION-owning tenant whose Portal email has no WP account, which is the
    // normal state for any teammate added in the Portal after provisioning.
    // The fallback existed so IA staff could always get in; it should never
    // have applied to clients.
    //
    // Resolved here rather than stamped at mint time so no schema change is
    // needed: the founder-tenant membership lookup is the same one
    // middleware/enforceViewAsReadOnly.js:126-145 uses.
    let allowAdminFallback = false;
    try {
      const founderTenantId = (process.env.FOUNDER_TENANT_ID
        || '8C9527B9-8999-4B31-A306-F3D4CCC39FBD').trim().toUpperCase();
      const { getPlatformPool } = await import('../db/platformPool.js');
      const pp = await getPlatformPool();
      const staff = await pp.request()
        .input('email', sql.NVarChar(320), lt.portal_user_email)
        .input('founderTenantId', sql.UniqueIdentifier, founderTenantId)
        .query(`
          SELECT TOP 1 1 AS hit
          FROM core.tenant_users tu
          JOIN core.users u ON u.user_id = tu.user_id
          WHERE tu.tenant_id = @founderTenantId
            AND (tu.status IS NULL OR tu.status = 'active')
            AND LOWER(u.email) = LOWER(@email)
        `);
      allowAdminFallback = staff.recordset.length > 0;
    } catch (staffErr) {
      // FAIL CLOSED. If we cannot prove the caller is IA staff, they do not get
      // the administrator fallback. A failed lookup must never widen access.
      console.warn('[arion/sso/verify] IA-staff check failed, denying admin fallback:', staffErr.message);
      allowAdminFallback = false;
    }

    res.json({
      ok: true,
      user: { email: lt.portal_user_email },
      site: { site_id: site.site_id, domain: site.domain },
      // Plugin v1.2.6+ honours this. Older plugin builds ignore it and keep the
      // old behaviour, so the plugin rollout is what actually closes the hole —
      // this half just makes the correct answer available.
      allow_admin_fallback: allowAdminFallback,
    });
  } catch (err) {
    console.error('[arion/sso/verify]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
