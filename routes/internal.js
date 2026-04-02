import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { completeProvisioning } from '../lib/provisioner.js';
import { firePlatformEvent } from '../lib/platformEvents.js';

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

export default router;
