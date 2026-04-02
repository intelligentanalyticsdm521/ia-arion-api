import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';
import { generateSiteToken, hashSiteToken } from '../../lib/siteToken.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';
import formsRouter from './forms.js';
import bookingsRouter from './bookings.js';
import gbpRouter from './gbp.js';
import integrationsRouter from './integrations.js';
import domainsRouter from './domains.js';

const router = Router();

// Mount sub-routers for site-scoped resources
router.use('/:siteId/forms', formsRouter);
router.use('/:siteId/bookings', bookingsRouter);
router.use('/:siteId/gbp', gbpRouter);
router.use('/:siteId', integrationsRouter);
router.use('/:siteId/domain', domainsRouter);

// GET /arion/sites - list sites for tenant
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * perPage;
  try {
    const pool = await getServicesPool();
    const [dataRes, countRes] = await Promise.all([
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('offset', sql.Int, offset)
        .input('perPage', sql.Int, perPage)
        .query(`
          SELECT site_id, domain, hosting_plan, status, ssl_expiry, arion_tier,
                 gbp_connected, gsc_connected, google_ads_linked, apple_claimed,
                 plugin_version, created_at, updated_at
          FROM arion.site
          WHERE tenant_id = @tenantId
          ORDER BY created_at DESC
          OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY
        `),
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT COUNT(*) AS total FROM arion.site WHERE tenant_id = @tenantId')
    ]);
    res.json({
      data: dataRes.recordset,
      meta: { total: countRes.recordset[0].total, page, per_page: perPage }
    });
  } catch (err) {
    console.error('[sites:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId - site detail
router.get('/:siteId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT site_id, domain, hosting_plan, wp_admin_url, status, ssl_expiry, arion_tier,
               gbp_connected, gbp_place_id, gsc_connected, google_ads_linked, apple_claimed,
               plugin_version, site_token_last_rotated, created_at, updated_at
        FROM arion.site
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    res.json({
      data: result.recordset[0],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[sites:get]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites - provision new site
router.post('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { domain, hosting_plan, arion_tier } = req.body;
  if (!domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain is required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const siteId = crypto.randomUUID();
    const rawToken = generateSiteToken();
    const tokenHash = hashSiteToken(rawToken);
    const now = new Date().toISOString();

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('domain', sql.NVarChar(253), domain)
        .input('hostingPlan', sql.NVarChar(50), hosting_plan || 'starter')
        .input('tier', sql.NVarChar(20), arion_tier || 'lite')
        .input('tokenHash', sql.NVarChar(64), tokenHash)
        .input('status', sql.NVarChar(30), 'provisioning')
        .query(`
          INSERT INTO arion.site
            (site_id, tenant_id, domain, hosting_plan, arion_tier, site_token_hash,
             site_token_last_rotated, status, gbp_connected, gsc_connected,
             google_ads_linked, apple_claimed, created_at, updated_at)
          VALUES
            (@siteId, @tenantId, @domain, @hostingPlan, @tier, @tokenHash,
             SYSDATETIMEOFFSET(), @status, 0, 0, 0, 0,
             SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
        `);

      await firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.site.provisioned',
        eventRefId: siteId,
        payload: { site_id: siteId, domain, arion_tier: arion_tier || 'lite' }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.status(202).json({
      data: { site_id: siteId, domain, status: 'provisioning', site_token: rawToken },
      meta: { tenant_id: tenantId, timestamp: now }
    });
  } catch (err) {
    console.error('[sites:create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/editor-link - generate Elementor deep link
router.get('/:siteId/editor-link', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT wp_admin_url FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    const wpAdminUrl = result.recordset[0].wp_admin_url;
    if (!wpAdminUrl) {
      return res.status(409).json({ error: { code: 'NOT_READY', message: 'Site not yet provisioned', status: 409 } });
    }
    const editorUrl = `${wpAdminUrl}/post.php?action=elementor`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    res.json({
      data: { editor_url: editorUrl, expires_at: expiresAt },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[sites:editor-link]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
