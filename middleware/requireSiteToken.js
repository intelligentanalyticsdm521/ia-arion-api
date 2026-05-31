import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { hashSiteToken } from '../lib/siteToken.js';

export async function requireSiteToken(req, res, next) {
  try {
    // F-127 (2026-05-31) — accept token from THREE sources, in priority order:
    //   1. Authorization: Bearer <token>  / Authorization: Token <token>  (canonical, used by direct API callers)
    //   2. X-Arion-Site-Token: <token>     (what the WordPress plugin v2.0.13 actually sends)
    //   3. X-Site-Token: <token>           (alternate naming sometimes used in docs)
    //
    // The plugin's `wp_remote_post(..., 'blocking' => false)` means it never
    // sees the 401, so every form submission failed silently from launch
    // until this defensive expansion. Server-side fix only — plugin doesn't
    // need to be redeployed.
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
    else if (authHeader?.startsWith('Token ')) token = authHeader.slice(6);
    if (!token) token = req.headers['x-arion-site-token'] || req.headers['x-site-token'] || null;

    if (!token) {
      return res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Site token required', status: 401 } });
    }

    // tenant_id is now OPTIONAL — if not provided, we derive it from the
    // site row matched by (site_id + token_hash). If provided, we still
    // validate that it matches as defense-in-depth.
    const claimedTenantId = req.body?.tenant_id || req.headers['x-tenant-id'] || null;
    const siteId = req.body?.site_id || req.headers['x-site-id'];

    if (!siteId) {
      return res.status(400).json({ error: { code: 'MISSING_CONTEXT', message: 'site_id is required (header X-Site-Id or body field)', status: 400 } });
    }

    const tokenHash = hashSiteToken(token);
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tokenHash', sql.NVarChar(64), tokenHash)
      .query(`
        SELECT site_id, tenant_id, arion_tier, domain
        FROM arion.site
        WHERE site_id = @siteId
          AND site_token_hash = @tokenHash
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired site token', status: 401 } });
    }

    const site = result.recordset[0];

    // If caller asserted a tenant_id, it must match the site's tenant.
    if (claimedTenantId && String(claimedTenantId).toLowerCase() !== String(site.tenant_id).toLowerCase()) {
      return res.status(403).json({ error: { code: 'TENANT_MISMATCH', message: 'Provided tenant_id does not match the site\'s tenant', status: 403 } });
    }

    req.site = site;
    req.tenant = { tenantId: site.tenant_id };
    next();
  } catch (err) {
    console.error('[requireSiteToken] error:', err);
    return res.status(500).json({ error: { code: 'AUTH_ERROR', message: 'Token validation failed', status: 500 } });
  }
}
