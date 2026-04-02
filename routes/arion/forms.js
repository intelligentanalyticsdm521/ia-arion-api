import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';

const router = Router({ mergeParams: true });

// GET /arion/sites/:siteId/forms - list form submissions
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * perPage;
  try {
    const pool = await getServicesPool();
    const [dataRes, countRes] = await Promise.all([
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('offset', sql.Int, offset)
        .input('perPage', sql.Int, perPage)
        .query(`
          SELECT submission_id, site_id, form_id, form_type, first_name, last_name,
                 email, phone, message, raw_fields, utm_source, utm_medium, utm_campaign,
                 contact_id, lead_id, processed, submitted_at, created_at
          FROM arion.site_form_submission
          WHERE tenant_id = @tenantId AND site_id = @siteId
          ORDER BY submitted_at DESC
          OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY
        `),
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query('SELECT COUNT(*) AS total FROM arion.site_form_submission WHERE tenant_id = @tenantId AND site_id = @siteId')
    ]);
    res.json({
      data: dataRes.recordset,
      meta: { total: countRes.recordset[0].total, page, per_page: perPage }
    });
  } catch (err) {
    console.error('[forms:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/forms/config - list form configs
router.get('/config', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT config_id, form_id, form_name, form_type, field_map, is_active,
               created_at, updated_at
        FROM arion.site_form_config
        WHERE tenant_id = @tenantId AND site_id = @siteId
        ORDER BY created_at DESC
      `);
    res.json({
      data: result.recordset,
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[forms:config:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/forms/config - upsert form config
router.post('/config', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { form_id, form_name, form_type, field_map, is_active } = req.body;
  if (!form_id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'form_id is required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const configId = crypto.randomUUID();
    await pool.request()
      .input('configId', sql.UniqueIdentifier, configId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('formId', sql.NVarChar(100), form_id)
      .input('formName', sql.NVarChar(200), form_name || null)
      .input('formType', sql.NVarChar(30), form_type || 'contact')
      .input('fieldMap', sql.NVarChar(sql.MAX), field_map ? JSON.stringify(field_map) : null)
      .input('isActive', sql.Bit, is_active !== false ? 1 : 0)
      .query(`
        MERGE arion.site_form_config AS target
        USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @formId AS form_id) AS source
        ON target.tenant_id = source.tenant_id
           AND target.site_id = source.site_id
           AND target.form_id = source.form_id
        WHEN MATCHED THEN
          UPDATE SET form_name = @formName, form_type = @formType, field_map = @fieldMap,
                     is_active = @isActive, updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (config_id, tenant_id, site_id, form_id, form_name, form_type,
                  field_map, is_active, created_at, updated_at)
          VALUES (@configId, @tenantId, @siteId, @formId, @formName, @formType,
                  @fieldMap, @isActive, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET());
      `);
    res.json({
      data: { config_id: configId, form_id, form_type: form_type || 'contact' },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[forms:config:upsert]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
