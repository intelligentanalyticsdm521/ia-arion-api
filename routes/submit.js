import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { requireSiteToken } from '../middleware/requireSiteToken.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { redeemProvisionCode } from '../lib/provisionCodes.js';
import { triggerOnboardingPageSpeed, getSiteForTenant } from './arion.js';
import { plugin as pluginApiFull } from '../lib/pluginClient.js';
import { generateSiteToken, hashSiteToken } from '../lib/siteToken.js';
import { upsertSparkContact } from '../lib/sparkContactSync.js';
import { resolveBookingTarget } from '../lib/websiteBuilder/brandContext.js';
import { getEntitlements } from '../lib/entitlements.js';
import { requireSiteArion } from '../middleware/requireSiteArion.js';
import { entitlementsFor, loadFormConfig, productState, sparkCaptureDecision } from '../lib/siteCaptureGate.js';
import { purchasedArionTier, effectiveArionTier } from '../lib/purchasedArionTier.js';

const router = Router();

// The collaborators the website routes call, in one object so a test can run
// the real handlers with the database, platform-api and the event writer
// stubbed. Production never changes these.
export const submitDeps = {
  getServicesPool,
  requireSiteToken,
  getEntitlements,
  upsertSparkContact,
  firePlatformEvent,
  resolveBookingTarget,
  redeemProvisionCode,
};

// requireSiteToken first (it finds the site and its business), then the ARION
// check: a business whose ARION has ended does not have its website collected.
const siteToken = (req, res, next) => submitDeps.requireSiteToken(req, res, next);
const siteArion = (req, res, next) => requireSiteArion({ getEntitlements: submitDeps.getEntitlements })(req, res, next);

// 2026-05-31 — F-125 backwards-compat shim for the WordPress plugin
// (intelligent-analytics v2.0.13). The plugin sends a flat object with a
// `fields: {Label: Value}` map (Elementor-style) and DOESN'T extract
// email/first_name/last_name/phone to top-level. arion-api previously
// validated `if (!email && !phone) return 400` and dropped every plugin
// submission silently (plugin uses non-blocking wp_remote_post, never
// sees the response). This shim extracts the canonical contact fields
// from the labelled map so plugin submissions land correctly without
// needing a plugin redeploy.
function extractContactFieldsFromMap(fieldsMap) {
  if (!fieldsMap || typeof fieldsMap !== 'object') return {};

  // Case-insensitive label → canonical-field lookup. First match wins.
  const patterns = {
    email:      /^(e[- ]?mail|email|email address|your email|work email)$/i,
    first_name: /^(first[- ]?name|first|fname|given name)$/i,
    last_name:  /^(last[- ]?name|last|lname|surname|family name)$/i,
    full_name:  /^(name|full name|your name|contact name)$/i,
    phone:      /^(phone|phone number|telephone|tel|mobile|cell|cell phone)$/i,
    message:    /^(message|comments?|notes?|inquiry|details|how can we help|how can we help\??)$/i,
  };

  const out = {};
  for (const [label, value] of Object.entries(fieldsMap)) {
    if (value === '' || value == null) continue;
    for (const [canonical, re] of Object.entries(patterns)) {
      if (re.test(String(label).trim()) && !out[canonical]) {
        out[canonical] = String(value).trim();
        break;
      }
    }
  }

  // If we got a full_name but no first/last, split on first whitespace.
  if (out.full_name && !out.first_name) {
    const parts = out.full_name.split(/\s+/);
    out.first_name = parts.shift();
    if (parts.length && !out.last_name) out.last_name = parts.join(' ');
  }
  delete out.full_name;

  return out;
}

router.post('/forms/submit', siteToken, siteArion, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.site.site_id;
  let {
    // No default here any more. Defaulting to 'contact' before consulting
    // arion.site_form_config meant the configured type could never win — every
    // submission arrived already typed, so a newsletter sign-up and a "get a
    // quote" form were indistinguishable downstream. The fallback moved below,
    // after the lookup.
    form_id, form_type, submission_key,
    email, first_name, last_name, phone, message,
    raw_fields, fields,            // accept plugin's `fields` as raw_fields alias
    utm_source, utm_medium, utm_campaign
  } = req.body;

  // Plugin-shape backfill: pull canonical contact fields out of the
  // Elementor-style label map if the caller didn't send them top-level.
  if (fields && (!email && !first_name && !last_name && !phone)) {
    const extracted = extractContactFieldsFromMap(fields);
    email      = email      || extracted.email      || null;
    first_name = first_name || extracted.first_name || null;
    last_name  = last_name  || extracted.last_name  || null;
    phone      = phone      || extracted.phone      || null;
    message    = message    || extracted.message    || null;
  }
  // What KIND of form is this?
  //
  // arion.site_form_config exists to answer exactly that — form_id to
  // form_type, per site — and nothing has ever read it. The caller's own
  // form_type still wins when it sends one (the plugin knows its own forms
  // best); the config fills the gap for everything else; 'contact' remains the
  // last resort, which is what every submission used to be regardless.
  //
  // The same row is also the form's "send to my SPARK inbox" switch (below).
  // loadFormConfig never throws: a broken lookup must not cost the ARION
  // record, and "no row" already means "not sent to SPARK".
  let formOutcomeCfg = null;
  if (form_id) {
    try {
      const pool = await submitDeps.getServicesPool();
      formOutcomeCfg = await loadFormConfig(pool, { tenantId, siteId, formId: form_id });
      // The caller's own type still wins — the plugin knows its own forms best.
      if (!form_type && formOutcomeCfg?.form_type) form_type = formOutcomeCfg.form_type;
    } catch (e) {
      // Never fail a real submission because the config lookup broke — losing
      // a lead is far worse than mistyping one.
      console.warn('[forms/submit] form config lookup failed:', e.message);
    }
  }
  if (!form_type) form_type = 'contact';

  // May this submission be written into SPARK? SPARK decided owned AND this
  // form switched on (an active site_form_config row). See lib/siteCaptureGate.js.
  const capture = sparkCaptureDecision({ payload: req.entitlements, formConfig: formOutcomeCfg, tenantId, where: 'form submission' });

  // Store the full submission either way so we don't lose data the
  // pattern matcher didn't recognize.
  if (!raw_fields && fields) raw_fields = fields;

  if (!email && !phone) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'At least email or phone is required', status: 400 } });
  }

  try {
    const pool = await submitDeps.getServicesPool();

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

      // SPARK CONTACT WRITE — ONLY BY SUBSCRIPTION AND ONLY FOR A FORM THAT IS
      // SET UP FOR IT (Brandon, 11 Oct 2026). This OVERRIDES the founder
      // decision of 2026-05-25 that every form submission also lands in
      // lumen.contact: a business without SPARK, or whose form is not switched
      // on (no active arion.site_form_config row), gets no SPARK row of any
      // kind — no contact, no activity, no tags, no list, no opt-in. The ARION
      // record above and the event below are written either way.
      // Idempotent when it does run — won't duplicate by (tenant_id, email).
      // F-128: upsertSparkContact ALSO applies lifecycle:lead + source:web_form
      // tags + writes a contact.created entry to lumen.contact_activity
      // when it creates a NEW contact.
      const contactUuid = capture.write
        ? await submitDeps.upsertSparkContact(transaction, {
          tenantId,
          firstName: first_name, lastName: last_name,
          email, phone,
          source: 'arion_form',
        })
        : null;

      // F-128 — write a form.submitted activity row regardless of whether
      // the contact is new or existing (returning visitors get the timeline
      // entry too). Best-effort inside the same tx — if it fails the form
      // submission still succeeds.
      if (contactUuid && (email || phone)) {
        try {
          const tenantLower = String(tenantId).toLowerCase();
          await new sql.Request(transaction)
            .input('tid', sql.NVarChar, tenantLower)
            .input('uuid', sql.UniqueIdentifier, contactUuid)
            .input('subId', sql.NVarChar, submissionId)
            .input('summary', sql.NVarChar,
              `Submitted ${form_type || 'contact'} form${form_id ? ` (${form_id})` : ''}`)
            .input('meta', sql.NVarChar,
              JSON.stringify({ form_id, form_type, utm_source, utm_medium, utm_campaign }))
            .query(`
              IF NOT EXISTS (
                SELECT 1 FROM lumen.contact_activity
                WHERE LOWER(tenant_id) = @tid
                  AND activity_type = 'form.submitted'
                  AND ref_id = @subId
              )
              BEGIN
                INSERT INTO lumen.contact_activity
                  (tenant_id, contact_id, product, activity_type, summary,
                   ref_type, ref_id, metadata_json, occurred_at)
                SELECT @tid, c.id, 'arion', 'form.submitted', @summary,
                       'form_submission', @subId, @meta, SYSUTCDATETIME()
                FROM lumen.contact c
                WHERE LOWER(c.tenant_id) = @tid
                  AND c.legacy_oliver_uuid = @uuid;
              END`);
        } catch (actErr) {
          console.warn('[submit:form] activity write failed (non-fatal):', actErr.message);
        }
      }

      // Do what this form is CONFIGURED to do with the person.
      //
      // upsertSparkContact already applies lifecycle:lead and source:web_form,
      // which say how the contact arrived. It cannot know what the form MEANS —
      // that a "join our newsletter" form should make somebody a newsletter
      // subscriber. Without this, a newsletter sign-up produced a contact
      // indistinguishable from a quote request and there was nothing to send
      // the newsletter to.
      //
      // Behaviour matches LUMEN-API lib/formOutcomes.js, which does the same
      // job for SPARK-hosted forms. Two services, one meaning: tags by NAME so
      // the config survives a tag being merged, and best-effort throughout,
      // because a tag that will not apply must never cost a captured lead.
      if (contactUuid && formOutcomeCfg) {
        try {
          let cfgTags = [];
          try {
            const parsed = JSON.parse(formOutcomeCfg.apply_tags || '[]');
            if (Array.isArray(parsed)) cfgTags = parsed.map(String).map(t => t.trim()).filter(Boolean);
          } catch { /* malformed config must not cost the lead */ }

          const tenantLower = String(tenantId).toLowerCase();
          for (const tagName of cfgTags) {
            await new sql.Request(transaction)
              .input('tid', sql.NVarChar, tenantLower)
              .input('name', sql.NVarChar, tagName)
              .input('uuid', sql.UniqueIdentifier, contactUuid)
              .query(`
                MERGE lumen.tag AS t
                USING (SELECT @tid AS tenant_id, @name AS name) AS s
                  ON LOWER(t.tenant_id) = s.tenant_id AND t.name = s.name
                WHEN NOT MATCHED THEN INSERT (tenant_id, name) VALUES (s.tenant_id, s.name);

                INSERT INTO lumen.contact_tag (contact_id, tag_id)
                SELECT c.id, t.id
                  FROM lumen.contact c
                  JOIN lumen.tag t ON LOWER(t.tenant_id) = @tid AND t.name = @name
                 WHERE LOWER(c.tenant_id) = @tid AND c.legacy_oliver_uuid = @uuid
                   AND NOT EXISTS (SELECT 1 FROM lumen.contact_tag ct
                                    WHERE ct.contact_id = c.id AND ct.tag_id = t.id);`);
          }

          // Number(null) is 0, so a config with no list would otherwise fire a
          // pointless insert against list zero on every submission.
          const cfgListId = formOutcomeCfg.add_to_list_id;
          if (cfgListId !== null && cfgListId !== undefined && Number(cfgListId) > 0) {
            await new sql.Request(transaction)
              .input('tid', sql.NVarChar, tenantLower)
              .input('listId', sql.Int, Number(cfgListId))
              .input('uuid', sql.UniqueIdentifier, contactUuid)
              .query(`
                INSERT INTO lumen.list_contact (list_id, contact_id)
                SELECT @listId, c.id
                  FROM lumen.contact c
                  JOIN lumen.list l ON l.id = @listId AND LOWER(l.tenant_id) = @tid
                 WHERE LOWER(c.tenant_id) = @tid AND c.legacy_oliver_uuid = @uuid
                   AND NOT EXISTS (SELECT 1 FROM lumen.list_contact lc
                                    WHERE lc.list_id = @listId AND lc.contact_id = c.id);`);
          }

          if (formOutcomeCfg.marketing_optin) {
            await new sql.Request(transaction)
              .input('tid', sql.NVarChar, tenantLower)
              .input('uuid', sql.UniqueIdentifier, contactUuid)
              .query(`UPDATE c SET c.marketing_optin = 1, c.updated_at = GETUTCDATE()
                        FROM lumen.contact c
                       WHERE LOWER(c.tenant_id) = @tid AND c.legacy_oliver_uuid = @uuid`);
          }
        } catch (outErr) {
          console.warn('[submit:form] form outcomes skipped (non-fatal):', outErr.message);
        }
      }

      await submitDeps.firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.form.submitted',
        eventRefId: submissionId,
        payload: { submission_id: submissionId, site_id: siteId, form_type, form_id, email, first_name, last_name, phone, utm_source, spark_capture: capture.capture }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ data: { submission_id: submissionId, duplicate: false, spark_capture: capture.capture }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[submit:form]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

router.post('/bookings/submit', siteToken, siteArion, async (req, res) => {
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
    const pool = await submitDeps.getServicesPool();

    if (submission_key) {
      const existing = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('submissionKey', sql.NVarChar(200), submission_key)
        .query('SELECT booking_request_id FROM arion.site_booking_request WHERE tenant_id = @tenantId AND submission_key = @submissionKey');
      if (existing.recordset.length > 0) {
        return res.json({ data: { booking_request_id: existing.recordset[0].booking_request_id, duplicate: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
      }
    }

    // Same rule as /forms/submit: SPARK owned AND this booking form switched on.
    const bookingCfg = await loadFormConfig(pool, { tenantId, siteId, formId: form_id });
    const capture = sparkCaptureDecision({ payload: req.entitlements, formConfig: bookingCfg, tenantId, where: 'booking request' });

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

      // SPARK contact write — pairs with the same gate in /forms/submit (and
      // overrides the 2026-05-25 "every submission lands in lumen.contact"
      // rule the same way). Booking forms additionally carry an address so we
      // backfill the structured address fields on lumen.contact.
      if (capture.write) {
        await submitDeps.upsertSparkContact(transaction, {
          tenantId,
          firstName: first_name, lastName: last_name,
          email, phone,
          addressStreet: address_line_1,
          addressCity: city,
          addressState: state,
          addressZip: postal_code,
          source: 'arion_booking',
        });
      }

      await submitDeps.firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.booking.requested',
        eventRefId: bookingId,
        payload: {
          booking_request_id: bookingId, site_id: siteId, form_id,
          email, first_name, last_name, phone,
          service_type, preferred_date, preferred_time,
          address_line_1, city, state, postal_code, utm_source,
          spark_capture: capture.capture,
        }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.json({ data: { booking_request_id: bookingId, duplicate: false, spark_capture: capture.capture }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[submit:booking]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /webhooks/site-event --- (receives events from the IA WordPress plugin)
router.post('/webhooks/site-event', siteToken, siteArion, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.site.site_id;

  // The IA Plugin sends the payload FLAT on the body root (event_type +
  // all content fields as siblings). A simple `{event_type, payload}`
  // destructure leaves `payload` undefined and loses every field. Accept
  // both shapes — nested `payload` object if present, otherwise treat the
  // whole body as the payload.
  const event_type = req.body?.event_type;
  const payload = (req.body && typeof req.body.payload === 'object' && req.body.payload !== null)
    ? req.body.payload
    : (req.body || {});

  if (!event_type) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'event_type is required', status: 400 } });
  }

  try {
    const pool = await submitDeps.getServicesPool();

    // A form event writes into SPARK under the same rule as /forms/submit.
    // Decided before the transaction opens; the event below is queued either
    // way and the processor decides delivery.
    const isFormEvent = event_type === 'form.submitted' && !!payload.email;
    const capture = isFormEvent
      ? sparkCaptureDecision({
        payload: req.entitlements,
        formConfig: await loadFormConfig(pool, { tenantId, siteId, formId: payload.form_id }),
        tenantId,
        where: 'site form event',
      })
      : null;

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      // ── form.submitted — persist to site_form_submission ──
      if (isFormEvent) {
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

        // SPARK contact write only when SPARK is owned and the form is set up
        // for it (overrides the founder decision of 2026-05-25; see /forms/submit).
        if (capture.write) {
          await submitDeps.upsertSparkContact(transaction, {
            tenantId,
            firstName: payload.first_name, lastName: payload.last_name,
            email: payload.email, phone: payload.phone,
            source: 'arion_form',
          });
        }

        payload.submission_id = submissionId;
        payload.spark_capture = capture.capture;
      }

      // ── Content lifecycle events → site_content_change ──
      if (event_type === 'post.published' || event_type === 'post.updated' || event_type === 'post.deleted' || event_type === 'post.unpublished' || event_type === 'page.published') {
        const changeType = event_type === 'post.deleted' ? 'deleted'
          : event_type === 'post.updated' ? 'updated'
          : event_type === 'post.unpublished' ? 'unpublished'
          : 'published';
        await transaction.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('postId', sql.BigInt, Number(payload.post_id) || 0)
          .input('postType', sql.NVarChar(40), payload.post_type || (event_type === 'page.published' ? 'page' : 'post'))
          .input('changeType', sql.NVarChar(20), changeType)
          .input('postUrl', sql.NVarChar(2000), payload.post_url || payload.page_url || null)
          .input('postTitle', sql.NVarChar(500), payload.post_title || payload.page_title || null)
          .input('authorId', sql.BigInt, Number(payload.author_id) || null)
          .input('wordCount', sql.Int, Number(payload.word_count) || null)
          .input('categoriesJson', sql.NVarChar(sql.MAX), Array.isArray(payload.categories) ? JSON.stringify(payload.categories) : null)
          .input('tagsJson', sql.NVarChar(sql.MAX), Array.isArray(payload.tags) ? JSON.stringify(payload.tags) : null)
          .query(`
            INSERT INTO arion.site_content_change
              (tenant_id, site_id, post_id, post_type, change_type, post_url, post_title,
               author_id, word_count, categories_json, tags_json)
            VALUES
              (@tenantId, @siteId, @postId, @postType, @changeType, @postUrl, @postTitle,
               @authorId, @wordCount, @categoriesJson, @tagsJson)
          `);
      }

      // ── Plugin / theme / core lifecycle → site_security_event (inventory changes are security-relevant) ──
      if (event_type.startsWith('plugin.') || event_type.startsWith('theme.') || event_type.startsWith('wp_core.')) {
        const severity = event_type === 'plugin.deleted' || event_type === 'wp_core.update_available' ? 'warning' : 'info';
        await transaction.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('eventType', sql.NVarChar(80), event_type)
          .input('severity', sql.NVarChar(20), severity)
          .input('title', sql.NVarChar(300), payload.plugin_name || payload.theme_name || payload.new_version || event_type)
          .input('detailJson', sql.NVarChar(sql.MAX), JSON.stringify(payload))
          .query(`
            INSERT INTO arion.site_security_event
              (tenant_id, site_id, event_type, severity, title, detail_json)
            VALUES
              (@tenantId, @siteId, @eventType, @severity, @title, @detailJson)
          `);
      }

      // ── Shield Security events (accepts legacy 'wordfence.*' too) ──
      if (event_type.startsWith('shield.') || event_type.startsWith('wordfence.')) {
        const severity = /attack|block|malware|lockout/i.test(event_type) ? 'critical' : 'warning';
        await transaction.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('eventType', sql.NVarChar(80), event_type)
          .input('severity', sql.NVarChar(20), severity)
          .input('title', sql.NVarChar(300), (payload.details && payload.details.title) || event_type)
          .input('detailJson', sql.NVarChar(sql.MAX), JSON.stringify(payload))
          .input('sourceIp', sql.NVarChar(45), payload.details?.ip || payload.ip || null)
          .query(`
            INSERT INTO arion.site_security_event
              (tenant_id, site_id, event_type, severity, title, detail_json, source_ip)
            VALUES
              (@tenantId, @siteId, @eventType, @severity, @title, @detailJson, @sourceIp)
          `);
      }

      // ── WooCommerce order events → site_woo_order ──
      if (event_type === 'woo.order.created' || event_type === 'woo.order.completed') {
        const status = event_type === 'woo.order.completed' ? 'completed' : 'created';
        const emailHash = payload.customer_email
          ? crypto.createHash('sha256').update(String(payload.customer_email).toLowerCase().trim()).digest('hex')
          : null;
        try {
          await transaction.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('siteId', sql.UniqueIdentifier, siteId)
            .input('sourceOrderId', sql.NVarChar(50), String(payload.order_id || ''))
            .input('status', sql.NVarChar(40), status)
            .input('orderTotal', sql.Decimal(18, 2), payload.order_total ? Number(payload.order_total) : null)
            .input('currency', sql.NVarChar(10), payload.currency || 'USD')
            .input('emailHash', sql.NVarChar(64), emailHash)
            .input('itemsJson', sql.NVarChar(sql.MAX), payload.items ? JSON.stringify(payload.items) : null)
            .query(`
              INSERT INTO arion.site_woo_order
                (tenant_id, site_id, source_order_id, order_status, order_total, currency, customer_email_hash, items_json)
              VALUES
                (@tenantId, @siteId, @sourceOrderId, @status, @orderTotal, @currency, @emailHash, @itemsJson)
            `);
        } catch (wooErr) {
          // Unique-index violation on (site_id, source_order_id, order_status) — ignore dupes
          if (!/UQ_woo_order_source/i.test(String(wooErr.message))) throw wooErr;
        }
      }

      // ── site.health.degraded + any other event — always fire platform event for downstream handlers ──

      // Update plugin_last_status_at + plugin_version on the site row (non-blocking bookkeeping)
      if (payload.plugin_version) {
        await transaction.request()
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('version', sql.NVarChar(20), String(payload.plugin_version))
          .input('status', sql.NVarChar(30), 'connected')
          .query(`
            UPDATE arion.site
            SET plugin_version = @version,
                plugin_status = @status,
                plugin_last_status_at = SYSDATETIMEOFFSET(),
                plugin_connected_at = ISNULL(plugin_connected_at, SYSDATETIMEOFFSET())
            WHERE site_id = @siteId
          `);
      }

      const eventId = await submitDeps.firePlatformEvent(transaction, {
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

// --- POST /public/provision-codes/redeem ---
// Public endpoint called by the IA Plugin to redeem a one-time provisioning
// code for site credentials. The plugin calls this directly (no site-token
// auth required yet — that's what this endpoint is issuing).
//
// Body: { code, site_url?, admin_email? }
// Returns: { site_id, tenant_id, site_token, tier, seo_addon, domain? }
router.post('/public/provision-codes/redeem', async (req, res) => {
  const { code, site_url, admin_email } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'code is required', status: 400 } });
  }

  try {
    const pool = await submitDeps.getServicesPool();
    const redemption = await submitDeps.redeemProvisionCode(pool, { code, fromUrl: site_url });

    if (!redemption.ok) {
      const statusMap = { invalid_format: 400, not_found: 404, already_redeemed: 410, expired: 410, revoked: 403 };
      const msgMap = {
        invalid_format: 'The provisioning code format is invalid.',
        not_found: 'No matching provisioning code found.',
        already_redeemed: 'This code has already been redeemed.',
        expired: 'This code has expired. Request a new one from your ARION admin.',
        revoked: 'This code was revoked.',
      };
      return res.status(statusMap[redemption.reason] || 400).json({
        error: { code: redemption.reason.toUpperCase(), message: msgMap[redemption.reason] || 'Code rejected', status: statusMap[redemption.reason] || 400 },
      });
    }

    const { tenant_id, site_id } = redemption.code_row;

    // Generate a fresh site_token and store its hash
    const rawToken = generateSiteToken();
    const tokenHash = hashSiteToken(rawToken);

    const siteUpd = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site_id)
      .input('tenantId', sql.UniqueIdentifier, tenant_id)
      .input('tokenHash', sql.NVarChar(64), tokenHash)
      .input('tokenRaw', sql.NVarChar(256), rawToken)
      .input('adminEmail', sql.NVarChar(254), admin_email || null)
      .query(`
        UPDATE arion.site
        SET site_token_hash = @tokenHash,
            site_token_raw = @tokenRaw,
            site_token_last_rotated = SYSDATETIMEOFFSET(),
            plugin_status = 'connected',
            plugin_connected_at = SYSDATETIMEOFFSET(),
            plugin_last_status_at = SYSDATETIMEOFFSET(),
            updated_at = SYSDATETIMEOFFSET()
        OUTPUT inserted.site_id, inserted.tenant_id, inserted.arion_tier, inserted.domain
        WHERE site_id = @siteId AND tenant_id = @tenantId
      `);

    if (siteUpd.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    const siteRow = siteUpd.recordset[0];

    // Fire provisioning event so platform event log captures this
    try {
      await submitDeps.firePlatformEvent(pool, {
        tenantId: tenant_id,
        eventType: 'arion.plugin.provisioned',
        sourceProduct: 'ia-plugin',
        eventRefId: site_id,
        payload: { site_id, site_url: site_url || null, admin_email: admin_email || null },
      });
    } catch (e) {
      console.warn('[provision:event]', e.message);
    }

    // Apply IA defaults (LiteSpeed + Wordfence + Rank Math + WP Mail SMTP
    // + Safe SVG) so the site is fully configured the moment the plugin
    // connects. Fire-and-forget; the plugin endpoint is idempotent.
    // Also kicks off a baseline PSI run so the client has real CWV data.
    (async () => {
      try {
        // Re-fetch site with token so we can call the plugin back
        const p = await submitDeps.getServicesPool();
        const siteWithToken = await getSiteForTenant(p, tenant_id, site_id);
        if (siteWithToken) {
          // Apply defaults — wait ~5s for plugin to be fully initialized
          setTimeout(async () => {
            try {
              const r = await pluginApiFull.applyIADefaults(siteWithToken);
              console.log(`[provision:apply-defaults] ${siteWithToken.domain}: ok=${r.ok} applied=${JSON.stringify(r.data?.results || {}).slice(0, 200)}`);
            } catch (e) {
              console.warn('[provision:apply-defaults]', e.message);
            }
          }, 5000);
        }
      } catch (e) {
        console.warn('[provision:apply-defaults:outer]', e.message);
      }

      try {
        const domainForPsi = siteRow.domain || (site_url ? new URL(site_url).hostname : null);
        if (domainForPsi) {
          triggerOnboardingPageSpeed(pool, tenant_id, site_id, domainForPsi);
        }
      } catch (e) {
        console.warn('[provision:onboarding-psi]', e.message);
      }
    })();

    // Pull site row tier info for the response
    const seoResult = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site_id)
      .query('SELECT arion_tier, seo_addon_tier FROM arion.site WHERE site_id = @siteId');

    // Ops B6 — where the site's "Book now" button should point, if the
    // business owns OLIVER and has an online booking page. A DECIDED answer is
    // always sent, '' included, because an empty value takes a stale button
    // back off (OLIVER ended, or no booking page). An UNDECIDED answer sends no
    // booking_url at all: the plugin only writes the option when the key is
    // present, so the site keeps what it had rather than losing a paying
    // business's button over a platform-api hiccup. Never fatal.
    const booking = await submitDeps.resolveBookingTarget(pool, tenant_id);

    // The tier the plugin stores (ia_tier) and gates its own features on
    // (book-now button, post forms, mega menu, ...). BY THE SUBSCRIPTION:
    // the ARION tier the business pays for stands; arion.site.arion_tier is
    // raise-only, so after a downgrade it still named the old, higher tier.
    // The site row is the fallback when the subscription carries no tier.
    const purchased = await purchasedArionTier(tenant_id, { getEntitlements: submitDeps.getEntitlements });
    const pluginTier = effectiveArionTier(purchased, seoResult.recordset[0]?.arion_tier);

    res.json({
      data: {
        provisioned: true,
        site_id,
        tenant_id,
        site_token: rawToken,            // RAW token returned ONLY here
        tier: pluginTier || null,
        seo_addon: seoResult.recordset[0]?.seo_addon_tier || null,
        domain: siteRow.domain || null,
        ...(booking.decided ? { booking_url: booking.href } : {}),
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[public:provision-codes:redeem]', err);
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
    const pool = await submitDeps.getServicesPool();

    // Verify the site_id exists (lightweight check, no token required)
    const siteResult = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site_id)
      .query('SELECT tenant_id FROM arion.site WHERE site_id = @siteId');

    if (siteResult.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SITE_NOT_FOUND', message: 'Unknown site_id', status: 404 } });
    }

    const tenantId = siteResult.recordset[0].tenant_id;

    // Page views are ARION data: stored only for a business that owns ARION.
    // Decided "not owned" stores nothing (silently, like every beacon reply);
    // undecided stores as before, because it is the business's own data.
    const arionState = productState(await entitlementsFor(tenantId, submitDeps.getEntitlements), 'arion');
    if (arionState === 'not_owned') {
      return res.json({ ok: true, stored: false });
    }
    if (arionState === 'undecided') {
      console.warn(`[webhooks:beacon] ARION subscription undecided for ${tenantId}; storing the page view as before`);
    }

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
          (view_id, site_id, page_url, referrer,
           scroll_depth, time_on_page, screen_width, created_at)
        VALUES
          (@pageViewId, @siteId, @pageUrl, @referrer,
           @scrollDepth, @timeOnPage, @screenWidth, SYSDATETIMEOFFSET())
      `);

    res.json({ ok: true });
  } catch (err) {
    // Beacon failures should be silent to the client — log server-side only
    console.error('[webhooks:beacon]', err);
    res.json({ ok: true });
  }
});

export default router;
