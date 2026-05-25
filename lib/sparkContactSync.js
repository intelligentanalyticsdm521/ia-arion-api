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
      OUTPUT INSERTED.legacy_oliver_uuid
      VALUES
        (@tenantId, @firstName, @lastName, @email, @phone, @company,
         @street, @city, @state, @zip, @source)`);
  return insertRes.recordset[0]?.legacy_oliver_uuid || null;
}
