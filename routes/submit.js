import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { requireSiteToken } from '../middleware/requireSiteToken.js';
import { firePlatformEvent } from '../lib/platformEvents.js';

const router = Router();

router.post('/forms/submit', requireSiteToken, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.site.site_id;
  const {
    form_id, form_type = 'contact', submission_key,
    email, first_name, last_name, phone, message,
    raw_fields, utm_source, utm_medium, utm_campaign
  } = req.body;

  if (!email && !phone) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'At least email or phone is required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    if (submission_key) {
      const existing = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('submissionKey', sql.NVarChar(200), submission_key)
        .query('SELECT submission_id FROM arion.site_form_submission WHERE tenant_id = @tenantId AND submission_key = @submissionKey');
      if (existing.recordset.length > 0) {
        return res.json({ data: { submission_id: existing.recordset[0].submission_id, duplicate: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
      }
    }

    const submissionId = crypto.randomUUID();
    const transaction = pool.transaction();
    await transaction.begin();

    try {
      await transaction.request()
        .input('submissionId', sql.UniqueIdentifier, submissionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('formId', sql.NVarChar(100), form_id || null)
        .input('formType', sql.NVarChar(30), form_type)
        .input('submissionKey', sql.NVarChar(200), submission_key || null)
        .input('firstName', sql.NVarChar(100), first_name || null)
        .input('lastName', sql.NVarChar(100), last_name || null)
        .input('email', sql.NVarChar(254), email || null)
        .input('phone', sql.NVarChar(30), phone || null)
        .input('message', sql.NVarChar(sql.MAX), message || null)
        .input('rawFields', sql.NVarChar(sql.MAX), raw_fields ? JSON.stringify(raw_fields) : null)
        .input('utmSource', sql.NVarChar(100), utm_source || null)
        .input('utmMedium', sql.NVarChar(100), utm_medium || null)
        .input('utmCampaign', sql.NVarChar(100), utm_campaign || null)
        .query(`
          INSERT INTO arion.site_form_submission
            (submission_id, tenant_id, site_id, form_id, form_type, submission_key,
             first_name, last_name, email, phone, message, raw_fields,
             utm_source, utm_medium, utm_campaign, processed, submitted_at, created_at)
          VALUES
            (@submissionId, @tenantId, @siteId, @formId, @formType, @submissionKey,
             @firstName, @lastName, @email, @phone, @message, @rawFields,
             @utmSource, @utmMedium, @utmCampaign, 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
        `);

      await firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.form.submitted',
        eventRefId: submissionId,
        payload: { submission_id: submissionId, site_id: siteId, form_type, form_id, email, first_name, last_name, phone, utm_source }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ data: { submission_id: submissionId, duplicate: false }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[submit:form]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

router.post('/bookings/submit', requireSiteToken, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.site.site_id;
  const {
    form_id, submission_key,
    email, first_name, last_name, phone,
    service_type, preferred_date, preferred_time,
    address_line_1, city, state, postal_code,
    message, raw_fields, utm_source, utm_medium, utm_campaign
  } = req.body;

  if (!email && !phone) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'At least email or phone is required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    if (submission_key) {
      const existing = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('submissionKey', sql.NVarChar(200), submission_key)
        .query('SELECT booking_request_id FROM arion.site_booking_request WHERE tenant_id = @tenantId AND submission_key = @submissionKey');
      if (existing.recordset.length > 0) {
        return res.json({ data: { booking_request_id: existing.recordset[0].booking_request_id, duplicate: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
      }
    }

    const bookingId = crypto.randomUUID();
    const transaction = pool.transaction();
    await transaction.begin();

    try {
      await transaction.request()
        .input('bookingId', sql.UniqueIdentifier, bookingId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('formId', sql.NVarChar(100), form_id || null)
        .input('submissionKey', sql.NVarChar(200), submission_key || null)
        .input('firstName', sql.NVarChar(100), first_name || null)
        .input('lastName', sql.NVarChar(100), last_name || null)
        .input('email', sql.NVarChar(254), email || null)
        .input('phone', sql.NVarChar(30), phone || null)
        .input('serviceType', sql.NVarChar(200), service_type || null)
        .input('preferredDate', sql.Date, preferred_date || null)
        .input('preferredTime', sql.NVarChar(50), preferred_time || null)
        .input('addressLine1', sql.NVarChar(200), address_line_1 || null)
        .input('city', sql.NVarChar(100), city || null)
        .input('state', sql.NVarChar(50), state || null)
        .input('postalCode', sql.NVarChar(20), postal_code || null)
        .input('message', sql.NVarChar(sql.MAX), message || null)
        .input('rawFields', sql.NVarChar(sql.MAX), raw_fields ? JSON.stringify(raw_fields) : null)
        .input('utmSource', sql.NVarChar(100), utm_source || null)
        .input('utmMedium', sql.NVarChar(100), utm_medium || null)
        .input('utmCampaign', sql.NVarChar(100), utm_campaign || null)
        .query(`
          INSERT INTO arion.site_booking_request
            (booking_request_id, tenant_id, site_id, form_id, submission_key,
             first_name, last_name, email, phone,
             service_type, preferred_date, preferred_time,
             address_line_1, city, state, postal_code,
             message, raw_fields, utm_source, utm_medium, utm_campaign,
             status, processed, submitted_at, created_at)
          VALUES
            (@bookingId, @tenantId, @siteId, @formId, @submissionKey,
             @firstName, @lastName, @email, @phone,
             @serviceType, @preferredDate, @preferredTime,
             @addressLine1, @city, @state, @postalCode,
             @message, @rawFields, @utmSource, @utmMedium, @utmCampaign,
             'new', 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
        `);

      await firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.booking.requested',
        eventRefId: bookingId,
        payload: {
          booking_request_id: bookingId, site_id: siteId, form_id,
          email, first_name, last_name, phone,
          service_type, preferred_date, preferred_time,
          address_line_1, city, state, postal_code, utm_source
        }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ data: { booking_request_id: bookingId, duplicate: false }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[submit:booking]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /webhooks/site-event --- (receives events from the IA WordPress plugin)
router.post('/webhooks/site-event', requireSiteToken, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.site.site_id;
  const { event_type, payload = {} } = req.body;

  if (!event_type) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'event_type is required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();
    const transaction = pool.transaction();
    await transaction.begin();

    try {
      // If the WP plugin sent a form submission event, also write to site_form_submission
      if (event_type === 'form.submitted' && payload.email) {
        const submissionId = crypto.randomUUID();
        await transaction.request()
          .input('submissionId', sql.UniqueIdentifier, submissionId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('formId', sql.NVarChar(100), payload.form_id || null)
          .input('formType', sql.NVarChar(30), payload.form_type || 'contact')
          .input('submissionKey', sql.NVarChar(200), payload.submission_key || null)
          .input('firstName', sql.NVarChar(100), payload.first_name || null)
          .input('lastName', sql.NVarChar(100), payload.last_name || null)
          .input('email', sql.NVarChar(254), payload.email || null)
          .input('phone', sql.NVarChar(30), payload.phone || null)
          .input('message', sql.NVarChar(sql.MAX), payload.message || null)
          .input('rawFields', sql.NVarChar(sql.MAX), payload.raw_fields ? JSON.stringify(payload.raw_fields) : null)
          .input('utmSource', sql.NVarChar(100), payload.utm_source || null)
          .input('utmMedium', sql.NVarChar(100), payload.utm_medium || null)
          .input('utmCampaign', sql.NVarChar(100), payload.utm_campaign || null)
          .query(`
            INSERT INTO arion.site_form_submission
              (submission_id, tenant_id, site_id, form_id, form_type, submission_key,
               first_name, last_name, email, phone, message, raw_fields,
               utm_source, utm_medium, utm_campaign, processed, submitted_at, created_at)
            VALUES
              (@submissionId, @tenantId, @siteId, @formId, @formType, @submissionKey,
               @firstName, @lastName, @email, @phone, @message, @rawFields,
               @utmSource, @utmMedium, @utmCampaign, 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
          `);

        payload.submission_id = submissionId;
      }

      const eventId = await firePlatformEvent(transaction, {
        tenantId,
        eventType: `arion.${event_type}`,
        sourceProduct: 'ia-plugin',
        eventRefId: payload.submission_id || null,
        payload: { ...payload, site_id: siteId }
      });

      await transaction.commit();

      res.json({ data: { event_id: eventId }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }
  } catch (err) {
    console.error('[webhooks:site-event]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /webhooks/beacon --- (lightweight ARGUS page view beacon, no token auth)
router.post('/webhooks/beacon', async (req, res) => {
  const { site_id, page_url, referrer, scroll_depth, time_on_page, screen_width, timestamp } = req.body;

  if (!site_id || !page_url) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id and page_url are required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    // Verify the site_id exists (lightweight check, no token required)
    const siteResult = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site_id)
      .query('SELECT tenant_id FROM arion.site WHERE site_id = @siteId');

    if (siteResult.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SITE_NOT_FOUND', message: 'Unknown site_id', status: 404 } });
    }

    const tenantId = siteResult.recordset[0].tenant_id;

    // Log the page view (insert into site_page_view if table exists, otherwise fire as event)
    const pageViewId = crypto.randomUUID();
    await pool.request()
      .input('pageViewId', sql.UniqueIdentifier, pageViewId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, site_id)
      .input('pageUrl', sql.NVarChar(2000), page_url)
      .input('referrer', sql.NVarChar(2000), referrer || null)
      .input('scrollDepth', sql.Int, scroll_depth || 0)
      .input('timeOnPage', sql.Int, time_on_page || 0)
      .input('screenWidth', sql.Int, screen_width || 0)
      .input('viewedAt', sql.NVarChar(50), timestamp || new Date().toISOString())
      .query(`
        INSERT INTO arion.site_page_view
          (page_view_id, tenant_id, site_id, page_url, referrer,
           scroll_depth, time_on_page, screen_width, viewed_at, created_at)
        VALUES
          (@pageViewId, @tenantId, @siteId, @pageUrl, @referrer,
           @scrollDepth, @timeOnPage, @screenWidth, @viewedAt, SYSDATETIMEOFFSET())
      `);

    res.json({ ok: true });
  } catch (err) {
    // Beacon failures should be silent to the client — log server-side only
    console.error('[webhooks:beacon]', err);
    res.json({ ok: true });
  }
});

export default router;
