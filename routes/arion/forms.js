import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';
import { pushSiteSubscriptionConfig } from '../../lib/websiteBuilder/subscriptionConfig.js';

const router = Router({ mergeParams: true });

// The collaborators these routes call, in one object so a test can run the
// real routes with the database and the website stubbed. Production never
// changes these.
export const formsDeps = { getServicesPool, pushSiteSubscriptionConfig };

// GET /arion/sites/:siteId/forms - list form submissions
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * perPage;
  try {
    const pool = await formsDeps.getServicesPool();
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
    const pool = await formsDeps.getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT config_id, form_id, form_name, form_type, field_map, is_active,
               apply_tags, add_to_list_id, marketing_optin,
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

// GET /arion/sites/:siteId/forms/seen - one row per form this site has seen,
// with its "Send this form to my SPARK inbox" switch.
//
// A form shows up here once it has sent a submission OR once it has a config
// row (set up before anybody filled it in). The switch is the config row's
// is_active; a form with no config row is OFF (config_id null, is_active false)
// until the business turns it on, exactly as iadm-webhooks and the submit
// route read it. form_name is the configured name when there is one, else a
// form_name field in the latest submission's raw_fields when there is one (the
// submit route keeps the plugin's fields there, not its form_name, today).
export const SEEN_FORMS_SQL = `
  WITH sub AS (
    SELECT form_id, form_type, submitted_at,
           CASE WHEN ISJSON(raw_fields) = 1 THEN JSON_VALUE(raw_fields, '$.form_name') END AS form_name,
           COUNT(*) OVER (PARTITION BY form_id) AS submissions,
           ROW_NUMBER() OVER (PARTITION BY form_id ORDER BY submitted_at DESC) AS rn
      FROM arion.site_form_submission
     WHERE tenant_id = @tenantId AND site_id = @siteId
  ),
  latest AS (
    SELECT form_id, form_type, form_name, submissions, submitted_at AS last_submitted_at
      FROM sub WHERE rn = 1
  ),
  cfg AS (
    SELECT config_id, form_id, form_name, form_type, is_active, updated_at
      FROM arion.site_form_config
     WHERE tenant_id = @tenantId AND site_id = @siteId
  )
  SELECT COALESCE(l.form_id, c.form_id)                 AS form_id,
         COALESCE(c.form_type, l.form_type, 'contact')  AS form_type,
         COALESCE(NULLIF(c.form_name, ''), l.form_name) AS form_name,
         COALESCE(l.submissions, 0)                     AS submissions,
         l.last_submitted_at                            AS last_submitted_at,
         c.config_id                                    AS config_id,
         c.is_active                                    AS is_active
    FROM latest l
    FULL OUTER JOIN cfg c ON c.form_id = l.form_id
   ORDER BY CASE WHEN l.last_submitted_at IS NULL THEN 1 ELSE 0 END,
            l.last_submitted_at DESC, COALESCE(c.form_name, l.form_name, c.form_id)`;

/** One row of /seen as the Portal reads it. */
export function publicSeenForm(row) {
  const r = row || {};
  const formId = r.form_id === null || r.form_id === undefined || r.form_id === '' ? null : String(r.form_id);
  return {
    form_id: formId,
    form_type: String(r.form_type || 'contact'),
    form_name: r.form_name ? String(r.form_name) : null,
    submissions: Number(r.submissions) || 0,
    last_submitted_at: r.last_submitted_at || null,
    config_id: r.config_id || null,
    // OFF until the business turns it on: no config row is false, not null.
    is_active: r.config_id ? r.is_active === true || r.is_active === 1 : false,
    // A submission with no form id cannot be matched to a switch, so the
    // Portal shows it without one.
    can_switch: formId !== null,
  };
}

router.get('/seen', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await formsDeps.getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(SEEN_FORMS_SQL);
    const data = (result.recordset || []).map(publicSeenForm);
    res.json({
      data,
      meta: { total: data.length, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[forms:seen]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/forms/config - upsert form config
//
// A PARTIAL BODY CHANGES ONLY WHAT IT NAMES. The Portal's switch sends just
// { form_id, is_active }; the SPARK outcomes editor sends the outcomes. Before
// 11 Oct 2026 every column absent from the body was written NULL on an
// existing row, so flipping the switch erased the form's tags, list and
// field map. Now a key that is absent keeps the stored value; a key that is
// present (even as null) is written. A new row is form_type 'contact' and
// OFF unless the body says is_active true: the row's is_active IS "Send this
// form to my SPARK inbox", which stays off until the business turns it on, so
// saving a form's outcomes first never switches its SPARK delivery on.
//
// A body may send field_map and apply_tags back exactly as GET /config gave
// them (JSON text) or parsed (an object, an array). Both are stored the same
// way, so "read the row, flip is_active, post it back" never double-encodes
// the field map or wipes the tags. A value that is neither is refused (400)
// and nothing is written.
//
// After the save the site is told what it may now do (ia_spark_capture and
// the ARION tier; lib/websiteBuilder/subscriptionConfig.js). The save never
// depends on the website answering: `website` in the answer says what
// happened there.
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

/** true | false for an is_active value; null when it is not a yes or a no. */
export function bitFrom(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

/**
 * Which columns this body sets, and to what. Pure, so the "a switch flip
 * never erases the outcomes" rule is testable on its own.
 */
/** A stored JSON value read back: an object or array as it is, JSON text parsed. */
function parsedJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** field_map -> { ok, value }: null clears it; an object (or its JSON text) is stored. */
export function fieldMapFrom(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const v = parsedJson(value);
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: JSON.stringify(v) };
  return { ok: false, value: null };
}

/** apply_tags -> { ok, value }: null clears them; an array of names (or its JSON text) is stored. */
export function tagsFrom(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const v = parsedJson(value);
  if (Array.isArray(v)) {
    return { ok: true, value: JSON.stringify(v.map(String).map(t => t.trim()).filter(Boolean)) };
  }
  return { ok: false, value: null };
}

export function configWrite(body) {
  const b = body && typeof body === 'object' ? body : {};
  const active = bitFrom(b.is_active);
  const optin = bitFrom(b.marketing_optin);
  const fieldMap = has(b, 'field_map') ? fieldMapFrom(b.field_map) : { ok: true, value: null };
  const tags = has(b, 'apply_tags') ? tagsFrom(b.apply_tags) : { ok: true, value: null };
  const invalid = [];
  if (!fieldMap.ok) invalid.push('field_map');
  if (!tags.ok) invalid.push('apply_tags');
  return {
    invalid,
    setFormName: has(b, 'form_name'),
    formName: b.form_name ? String(b.form_name) : null,
    setFormType: has(b, 'form_type') && !!b.form_type,
    formType: b.form_type ? String(b.form_type) : 'contact',
    setFieldMap: has(b, 'field_map'),
    fieldMap: fieldMap.value,
    setIsActive: active !== null,
    // A new row is OFF unless the body turns it on (see the note above).
    isActive: active === true ? 1 : 0,
    // What should HAPPEN to whoever fills this form in. Tags are stored by
    // NAME so the config survives a tag being merged or recreated, and reads
    // as what it means rather than as an id nobody can interpret.
    setApplyTags: has(b, 'apply_tags'),
    applyTags: tags.value,
    setAddToList: has(b, 'add_to_list_id'),
    addToListId: b.add_to_list_id !== null && b.add_to_list_id !== '' && typeof b.add_to_list_id !== 'boolean'
      && Number.isFinite(Number(b.add_to_list_id)) ? Number(b.add_to_list_id) : null,
    setMarketingOptin: has(b, 'marketing_optin'),
    marketingOptin: optin === null ? (b.marketing_optin ? 1 : 0) : (optin ? 1 : 0),
  };
}

export const CONFIG_MERGE_SQL = `
  MERGE arion.site_form_config AS target
  USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @formId AS form_id) AS source
  ON target.tenant_id = source.tenant_id
     AND target.site_id = source.site_id
     AND target.form_id = source.form_id
  WHEN MATCHED THEN
    UPDATE SET form_name = CASE WHEN @setFormName = 1 THEN @formName ELSE target.form_name END,
               form_type = CASE WHEN @setFormType = 1 THEN @formType ELSE target.form_type END,
               field_map = CASE WHEN @setFieldMap = 1 THEN @fieldMap ELSE target.field_map END,
               is_active = CASE WHEN @setIsActive = 1 THEN @isActive ELSE target.is_active END,
               apply_tags = CASE WHEN @setApplyTags = 1 THEN @applyTags ELSE target.apply_tags END,
               add_to_list_id = CASE WHEN @setAddToList = 1 THEN @addToListId ELSE target.add_to_list_id END,
               marketing_optin = CASE WHEN @setMarketingOptin = 1 THEN @marketingOptin ELSE target.marketing_optin END,
               updated_at = SYSDATETIMEOFFSET()
  WHEN NOT MATCHED THEN
    INSERT (config_id, tenant_id, site_id, form_id, form_name, form_type,
            field_map, is_active, apply_tags, add_to_list_id, marketing_optin,
            created_at, updated_at)
    VALUES (@configId, @tenantId, @siteId, @formId, @formName, @formType,
            @fieldMap, @isActive, @applyTags, @addToListId, @marketingOptin,
            SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
  OUTPUT inserted.config_id, inserted.form_type, inserted.is_active, $action AS merge_action;`;

/** The full arion.site row for this business's site (the token lives on it), or null. */
async function loadOwnSite(pool, tenantId, siteId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query('SELECT TOP 1 * FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
  return r?.recordset?.[0] || null;
}

/** Tell the site what it may now do. Never throws; never fails the save. */
async function tellWebsite(pool, tenantId, siteId) {
  try {
    const site = await loadOwnSite(pool, tenantId, siteId);
    if (!site) return { pushed: false, outcome: 'site_not_found' };
    const r = await formsDeps.pushSiteSubscriptionConfig(pool, site, { timeoutMs: 8000 });
    return {
      pushed: r.pushed,
      outcome: r.outcome,
      spark_capture: r.body.ia_spark_capture,
      capture_reason: r.capture_reason,
      tier: r.body.ia_tier || null,
      tier_reason: r.tier_reason,
    };
  } catch (err) {
    console.warn('[forms:config:website]', err?.message);
    return { pushed: false, outcome: 'failed' };
  }
}

router.post('/config', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { form_id } = body;
  if (!form_id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'form_id is required', status: 400 } });
  }
  if (has(body, 'is_active') && bitFrom(body.is_active) === null) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'is_active must be true or false', status: 400 } });
  }
  const w = configWrite(body);
  if (w.invalid.length) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `${w.invalid.join(' and ')} could not be read, so nothing was saved`, status: 400 } });
  }
  try {
    const pool = await formsDeps.getServicesPool();
    const result = await pool.request()
      .input('configId', sql.UniqueIdentifier, crypto.randomUUID())
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('formId', sql.NVarChar(100), String(form_id))
      .input('setFormName', sql.Bit, w.setFormName ? 1 : 0)
      .input('formName', sql.NVarChar(200), w.formName)
      .input('setFormType', sql.Bit, w.setFormType ? 1 : 0)
      .input('formType', sql.NVarChar(30), w.formType)
      .input('setFieldMap', sql.Bit, w.setFieldMap ? 1 : 0)
      .input('fieldMap', sql.NVarChar(sql.MAX), w.fieldMap)
      .input('setIsActive', sql.Bit, w.setIsActive ? 1 : 0)
      .input('isActive', sql.Bit, w.isActive)
      .input('setApplyTags', sql.Bit, w.setApplyTags ? 1 : 0)
      .input('applyTags', sql.NVarChar(1000), w.applyTags)
      .input('setAddToList', sql.Bit, w.setAddToList ? 1 : 0)
      .input('addToListId', sql.Int, w.addToListId)
      .input('setMarketingOptin', sql.Bit, w.setMarketingOptin ? 1 : 0)
      .input('marketingOptin', sql.Bit, w.marketingOptin)
      .query(CONFIG_MERGE_SQL);
    const saved = result?.recordset?.[0] || {};
    const website = await tellWebsite(pool, tenantId, siteId);
    res.json({
      data: {
        config_id: saved.config_id || null,
        form_id: String(form_id),
        form_type: saved.form_type || w.formType,
        is_active: saved.is_active === undefined ? null : (saved.is_active === true || saved.is_active === 1),
        created: saved.merge_action === 'INSERT',
        website,
      },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[forms:config:upsert]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// DELETE /arion/sites/:siteId/forms/submissions/:submissionId — delete a single
// form submission (spam cleanup). Per Brandon 2026-06-18: tenants need to
// be able to delete spam from their inbox without it polluting reports.
// Hard delete — form submissions are not legally retained.
router.delete('/submissions/:submissionId', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const siteId = req.params.siteId;
  const submissionId = req.params.submissionId;
  if (!tenantId) return res.status(401).json({ error: { code: 'BUSINESS_NOT_RESOLVED', message: "We couldn't tell which business you're working in. Reload the page, or sign out and sign in again." } });
  try {
    const pool = await formsDeps.getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('submissionId', sql.UniqueIdentifier, submissionId)
      .query(`
        DELETE FROM arion.site_form_submission
         WHERE tenant_id = @tenantId
           AND site_id = @siteId
           AND submission_id = @submissionId
      `);
    if (!r.rowsAffected[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'submission not found' } });
    }
    res.json({ data: { deleted: true, submission_id: submissionId } });
  } catch (err) {
    console.error('[forms:submission:delete]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/forms/submissions/bulk-delete — body { submission_ids: [...] }
// Bulk delete for spam wave cleanup. Returns count deleted.
router.post('/submissions/bulk-delete', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const siteId = req.params.siteId;
  const ids = Array.isArray(req.body?.submission_ids) ? req.body.submission_ids : [];
  if (!tenantId) return res.status(401).json({ error: { code: 'BUSINESS_NOT_RESOLVED', message: "We couldn't tell which business you're working in. Reload the page, or sign out and sign in again." } });
  if (!ids.length) return res.json({ data: { deleted: 0 } });
  try {
    const pool = await formsDeps.getServicesPool();
    let deleted = 0;
    for (const id of ids.slice(0, 500)) {
      try {
        const r = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('submissionId', sql.UniqueIdentifier, id)
          .query(`
            DELETE FROM arion.site_form_submission
             WHERE tenant_id = @tenantId AND site_id = @siteId AND submission_id = @submissionId
          `);
        if (r.rowsAffected[0]) deleted++;
      } catch { /* skip bad ids, continue */ }
    }
    res.json({ data: { deleted } });
  } catch (err) {
    console.error('[forms:submission:bulk-delete]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
