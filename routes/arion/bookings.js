import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';

const router = Router({ mergeParams: true });

// GET /arion/sites/:siteId/bookings - list booking requests
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * perPage;
  const statusFilter = req.query.status;
  try {
    const pool = await getServicesPool();
    const dataReq = pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('offset', sql.Int, offset)
      .input('perPage', sql.Int, perPage);
    const countReq = pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId);

    let statusClause = '';
    if (statusFilter) {
      statusClause = ' AND status = @status';
      dataReq.input('status', sql.NVarChar(30), statusFilter);
      countReq.input('status', sql.NVarChar(30), statusFilter);
    }

    const [dataRes, countRes] = await Promise.all([
      dataReq.query(`
        SELECT booking_request_id, site_id, form_id, first_name, last_name, email, phone,
               service_type, preferred_date, preferred_time, address_line_1, city, state,
               postal_code, message, status, contact_id, lead_id, oliver_inquiry_id,
               processed, submitted_at, created_at
        FROM arion.site_booking_request
        WHERE tenant_id = @tenantId AND site_id = @siteId${statusClause}
        ORDER BY submitted_at DESC
        OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY
      `),
      countReq.query(
        `SELECT COUNT(*) AS total FROM arion.site_booking_request WHERE tenant_id = @tenantId AND site_id = @siteId${statusClause}`
      )
    ]);
    res.json({
      data: dataRes.recordset,
      meta: { total: countRes.recordset[0].total, page, per_page: perPage }
    });
  } catch (err) {
    console.error('[bookings:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
