// lib/sparkContactSync.js
//
// AS OF 2026-05-25: ARION form submissions ALSO write a row to
// lumen.contact (the SPARK CRM master) so customer data lives in one
// place. The arion.site_form_submission / site_booking_request rows
// remain as raw audit trail, but downstream OLIVER/SPARK flows read
// from lumen.contact only.
//
// Idempotent upsert: dedupe by (tenant_id, email). When a contact
// already exists, ONLY fills in fields that are currently NULL in
// lumen.contact (don't clobber SPARK-side edits).

import sql from 'mssql';

/**
 * Upsert a contact into lumen.contact within an existing transaction.
 * Returns the legacy_oliver_uuid (the cross-product contact id).
 *
 * @param {sql.Transaction} transaction — already-begun mssql transaction
 * @param {object} opts — { tenantId, firstName, lastName, email, phone,
 *                          company, addressStreet, addressCity,
 *                          addressState, addressZip, source }
 */
export async function upsertSparkContact(transaction, opts) {
  const {
    tenantId, firstName, lastName, email, phone, company,
    addressStreet, addressCity, addressState, addressZip,
    source = 'arion_form',
  } = opts;

  if (!email && !phone) return null; // can't dedupe without contact info

  // lumen.contact stores tenant_id as lowercase nvarchar.
  const tenantLower = String(tenantId).toLowerCase();

  // Look up existing contact by (tenant, email) — case-insensitive.
  let existingUuid = null;
  if (email) {
    const r = await new sql.Request(transaction)
      .input('tenantId', sql.NVarChar, tenantLower)
      .input('email', sql.NVarChar, email)
      .query(`SELECT TOP 1 legacy_oliver_uuid FROM lumen.contact
              WHERE LOWER(tenant_id) = @tenantId AND LOWER(email) = LOWER(@email)`);
    existingUuid = r.recordset[0]?.legacy_oliver_uuid || null;
  }

  if (existingUuid) {
    // UPDATE — only fill NULL fields (don't clobber SPARK-side edits).
    await new sql.Request(transaction)
      .input('uuid', sql.UniqueIdentifier, existingUuid)
      .input('firstName', sql.NVarChar, firstName || null)
      .input('lastName', sql.NVarChar, lastName || null)
      .input('phone', sql.NVarChar, phone || null)
      .input('company', sql.NVarChar, company || null)
      .input('street', sql.NVarChar, addressStreet || null)
      .input('city', sql.NVarChar, addressCity || null)
      .input('state', sql.NVarChar, addressState || null)
      .input('zip', sql.NVarChar, addressZip || null)
      .query(`
        UPDATE lumen.contact SET
          first_name     = COALESCE(first_name, @firstName),
          last_name      = COALESCE(last_name, @lastName),
          phone          = COALESCE(phone, @phone),
          company        = COALESCE(company, @company),
          address_street = COALESCE(address_street, @street),
          address_city   = COALESCE(address_city, @city),
          address_state  = COALESCE(address_state, @state),
          address_zip    = COALESCE(address_zip, @zip)
        WHERE legacy_oliver_uuid = @uuid`);
    return existingUuid;
  }

  // INSERT — legacy_oliver_uuid defaults to NEWID().
  const insertRes = await new sql.Request(transaction)
    .input('tenantId', sql.NVarChar, tenantLower)
    .input('firstName', sql.NVarChar, firstName || null)
    .input('lastName', sql.NVarChar, lastName || null)
    .input('email', sql.NVarChar, email || null)
    .input('phone', sql.NVarChar, phone || null)
    .input('company', sql.NVarChar, company || null)
    .input('street', sql.NVarChar, addressStreet || null)
    .input('city', sql.NVarChar, addressCity || null)
    .input('state', sql.NVarChar, addressState || null)
    .input('zip', sql.NVarChar, addressZip || null)
    .input('source', sql.NVarChar, source)
    .query(`
      INSERT INTO lumen.contact
        (tenant_id, first_name, last_name, email, phone, company,
         address_street, address_city, address_state, address_zip, source)
      OUTPUT INSERTED.id AS id, INSERTED.legacy_oliver_uuid AS uuid
      VALUES
        (@tenantId, @firstName, @lastName, @email, @phone, @company,
         @street, @city, @state, @zip, @source)`);
  const newRow = insertRes.recordset[0];
  const newId  = newRow?.id;
  const newUuid = newRow?.uuid;

  // F-128 — auto-apply tags + write activity for brand-new contacts.
  // Best-effort: a failure here MUST NOT roll back the contact insert.
  if (newId) {
    try {
      await applyNewContactTagsInline(transaction, tenantLower, newId, source);
      await recordContactCreatedActivity(transaction, tenantLower, newId, source);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[sparkContactSync] tag/activity apply failed (non-fatal):', e.message);
    }
  }
  return newUuid;
}

// ── F-128 inline helpers (mirror oliver-api/lib/contactTags + contactActivity) ─

// Map lumen.contact.source values to the canonical source tag name.
const SOURCE_TO_TAG = {
  oliver_booking:   'source:booking',
  oliver_inline:    'source:manual',
  arion_form:       'source:web_form',
  spark_form:       'source:web_form',
  spark_import:     'source:csv_import',
  spark_manual:     'source:manual',
  stripe_sync:      'source:stripe_sync',
};

async function applyNewContactTagsInline(transaction, tenantLower, contactId, source) {
  // Resolve the system tag IDs we want to apply.
  const wanted = ['lifecycle:lead'];
  const srcTag = SOURCE_TO_TAG[source];
  if (srcTag) wanted.push(srcTag);

  // SELECT the tag IDs that exist for this tenant.
  const req = new sql.Request(transaction).input('tid', sql.NVarChar, tenantLower);
  wanted.forEach((name, i) => req.input(`n${i}`, sql.NVarChar, name));
  const r = await req.query(`
    SELECT id FROM lumen.tag
    WHERE LOWER(tenant_id) = @tid
      AND is_system = 1
      AND name IN (${wanted.map((_, i) => `@n${i}`).join(',')})`);

  // INSERT each link if missing.
  for (const row of r.recordset) {
    await new sql.Request(transaction)
      .input('cid', sql.Int, contactId)
      .input('tagid', sql.Int, row.id)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM lumen.contact_tag WHERE contact_id = @cid AND tag_id = @tagid)
        BEGIN
          INSERT INTO lumen.contact_tag (contact_id, tag_id) VALUES (@cid, @tagid);
        END`);
  }
}

async function recordContactCreatedActivity(transaction, tenantLower, contactId, source) {
  const sourceLabel = ({
    oliver_booking: 'OLIVER booking page',
    arion_form:     'ARION site form',
    spark_form:     'SPARK form',
    spark_import:   'SPARK CSV import',
    spark_manual:   'manual entry',
    oliver_inline:  'manual entry in OLIVER',
    stripe_sync:    'Stripe sync',
  })[source] || (source || 'unknown source');

  await new sql.Request(transaction)
    .input('tid', sql.NVarChar, tenantLower)
    .input('cid', sql.Int, contactId)
    .input('summary', sql.NVarChar, `Added to CRM via ${sourceLabel}`)
    .input('source', sql.NVarChar, source || null)
    .input('refId', sql.NVarChar, String(contactId))
    .query(`
      IF NOT EXISTS (
        SELECT 1 FROM lumen.contact_activity
        WHERE LOWER(tenant_id) = @tid
          AND activity_type = 'contact.created'
          AND ref_id = @refId
      )
      BEGIN
        INSERT INTO lumen.contact_activity
          (tenant_id, contact_id, product, activity_type, summary,
           ref_type, ref_id, metadata_json, occurred_at)
        VALUES
          (@tid, @cid, 'spark', 'contact.created', @summary,
           'contact', @refId,
           (SELECT @source AS source FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
           SYSUTCDATETIME());
      END`);
}
