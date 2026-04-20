import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { hashSiteToken } from '../lib/siteToken.js';

export async function requireSiteToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    // Accept both `Bearer <token>` and `Token <token>` prefixes — the IA plugin
    // sends `Token <token>` per its historical convention.
    let token = null;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
    else if (authHeader?.startsWith('Token ')) token = authHeader.slice(6);
    if (!token) {
      return res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Site token required', status: 401 } });
    }

    const tenantId = req.body?.tenant_id || req.headers['x-tenant-id'];
    const siteId = req.body?.site_id || req.headers['x-site-id'];

    if (!tenantId || !siteId) {
      return res.status(400).json({ error: { code: 'MISSING_CONTEXT', message: 'tenant_id and site_id are required', status: 400 } });
    }

    const tokenHash = hashSiteToken(token);
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tokenHash', sql.NVarChar(64), tokenHash)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT site_id, tenant_id, arion_tier, domain
        FROM arion.site
        WHERE site_id = @siteId
          AND site_token_hash = @tokenHash
          AND tenant_id = @tenantId
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired site token', status: 401 } });
    }

    const site = result.recordset[0];
    req.site = site;
    req.tenant = { tenantId: site.tenant_id };
    next();
  } catch (err) {
    console.error('[requireSiteToken] error:', err);
    return res.status(500).json({ error: { code: 'AUTH_ERROR', message: 'Token validation failed', status: 500 } });
  }
}
