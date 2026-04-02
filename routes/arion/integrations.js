import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { meetsMinTier } from '../../lib/tierCheck.js';

const router = Router({ mergeParams: true });

// GET /gsc - Google Search Console data (Standard+ tier)
router.get('/gsc', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;

  if (!meetsMinTier(req.site.tier, 'standard')) {
    return res.status(403).json({ error: { code: 'TIER_REQUIRED', message: 'Standard tier or above is required for GSC data', status: 403 } });
  }

  const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('days', sql.Int, days)
      .query('SELECT * FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -@days, GETUTCDATE()) ORDER BY report_date DESC');

    res.json({ data: result.recordset, meta: { tenant_id: tenantId, days, count: result.recordset.length, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[integrations:gsc]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /seo-summary - SE Ranking data
router.get('/seo-summary', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT TOP 1 * FROM arion.se_ranking_summary WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY fetched_at DESC');

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No SEO summary data available', status: 404 } });
    }

    res.json({ data: result.recordset[0], meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[integrations:seo-summary]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /ads - Google Ads data (read-only)
router.get('/ads', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('days', sql.Int, days)
      .query('SELECT * FROM arion.google_ads_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -@days, GETUTCDATE()) ORDER BY report_date DESC');

    res.json({ data: result.recordset, meta: { tenant_id: tenantId, days, count: result.recordset.length, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[integrations:ads]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
