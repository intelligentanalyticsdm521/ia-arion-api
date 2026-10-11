import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';

const router = Router({ mergeParams: true });

// Which plan these routes need is the feature catalog's, not this file's:
// every /sites/:siteId/gbp path is gated on its Business Profile key by
// middleware/arionRouteFeatures.js (arion_business_overview / _reviews /
// _locations), mounted in front of /arion.

// GET / - GBP profile
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId');

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'GBP profile not found', status: 404 } });
    }

    res.json({ data: result.recordset[0], meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp:get]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// PATCH / - update GBP
router.patch('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;

  const { business_name, description, phone, website, address, categories, hours } = req.body;

  try {
    const pool = await getServicesPool();
    const request = pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId);

    const setClauses = [];
    if (business_name !== undefined) { request.input('businessName', sql.NVarChar(200), business_name); setClauses.push('business_name = @businessName'); }
    if (description !== undefined) { request.input('description', sql.NVarChar(sql.MAX), description); setClauses.push('description = @description'); }
    if (phone !== undefined) { request.input('phone', sql.NVarChar(30), phone); setClauses.push('phone = @phone'); }
    if (website !== undefined) { request.input('website', sql.NVarChar(500), website); setClauses.push('website = @website'); }
    if (address !== undefined) { request.input('address', sql.NVarChar(sql.MAX), JSON.stringify(address)); setClauses.push('address = @address'); }
    if (categories !== undefined) { request.input('categories', sql.NVarChar(sql.MAX), JSON.stringify(categories)); setClauses.push('categories = @categories'); }
    if (hours !== undefined) { request.input('hours', sql.NVarChar(sql.MAX), JSON.stringify(hours)); setClauses.push('hours = @hours'); }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update', status: 400 } });
    }

    setClauses.push('updated_at = SYSDATETIMEOFFSET()');
    const query = 'UPDATE arion.gbp_profile SET ' + setClauses.join(', ') + ' WHERE tenant_id = @tenantId AND site_id = @siteId';
    await request.query(query);

    res.json({ data: { updated: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp:patch]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /insights - 90-day GBP insights
router.get('/insights', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT * FROM arion.gbp_insights WHERE tenant_id = @tenantId AND site_id = @siteId AND period_start >= DATEADD(day, -90, GETUTCDATE()) ORDER BY period_start DESC');

    res.json({ data: result.recordset, meta: { tenant_id: tenantId, count: result.recordset.length, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp:insights]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /reviews - list reviews
router.get('/reviews', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;

  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize)
      .query('SELECT * FROM arion.gbp_review WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY review_date DESC OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY');

    const countResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT COUNT(*) AS total FROM arion.gbp_review WHERE tenant_id = @tenantId AND site_id = @siteId');

    res.json({ data: result.recordset, meta: { tenant_id: tenantId, page, pageSize, total: countResult.recordset[0].total, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp:reviews]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /reviews/:reviewId/reply - reply to review
router.post('/reviews/:reviewId/reply', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;
  const reviewId = req.params.reviewId;

  const { reply_text } = req.body;
  if (!reply_text || !reply_text.trim()) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'reply_text is required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    const existing = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('reviewId', sql.UniqueIdentifier, reviewId)
      .query('SELECT review_id FROM arion.gbp_review WHERE tenant_id = @tenantId AND site_id = @siteId AND review_id = @reviewId');

    if (existing.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found', status: 404 } });
    }

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('reviewId', sql.UniqueIdentifier, reviewId)
      .input('replyText', sql.NVarChar(sql.MAX), reply_text.trim())
      // 2026-08-16: arion.gbp_review has neither reply_date nor updated_at, so
      // replying to a Google review 500'd every time. Real columns are
      // reply_text / reply_status / review_date / synced_at.
      .query("UPDATE arion.gbp_review SET reply_text = @replyText, reply_status = 'replied', synced_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND review_id = @reviewId");

    res.json({ data: { review_id: reviewId, replied: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp:reply]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
