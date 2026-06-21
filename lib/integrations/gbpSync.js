// lib/integrations/gbpSync.js
//
// Multi-location Google Business Profile sync.
//
// Why this exists:
//   Onboarding V3 Phase 3 supports tenants with more than one GBP listing
//   (a regional plumbing co with 4 branches, a multi-location dental
//   practice, etc.). The legacy ARION flow stored one location per site on
//   arion.site.gbp_location_name. That's still the per-site SELECTION; this
//   sync layer is the canonical set of ALL locations the OAuth'd user can
//   access, written to arion.business_location.
//
// What it does:
//   1. Enumerate every account the OAuth'd user owns
//   2. Enumerate every location under each account (reusing
//      lib/gbpApi.js#listAllGbpLocations so we keep ONE place that knows the
//      Google API)
//   3. Upsert each location into arion.business_location keyed by
//      (tenant_id, gbp_location_id)
//   4. Mark any location no longer returned by Google as removed (delete)
//   5. If no row is is_primary=1 yet, promote the first location to primary
//   6. Log to arion.site_integration_status as an audit breadcrumb
//
// Idempotent. Safe to re-run on every OAuth completion + on every cron pass.
//
// References:
//   lib/gbpApi.js               — Google API client (single source of truth)
//   db/migrations/027_arion_business_location.sql — target table

import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { listAllGbpLocations } from '../gbpApi.js';

/**
 * Pull every location/account from Google and upsert into
 * arion.business_location.
 *
 * @param {string} tenantId    UUID of the tenant
 * @param {string} accessToken OAuth access token (already exchanged from refresh)
 * @param {object} opts
 * @param {string} [opts.siteId]        Optional site_id to associate with these locations
 * @param {string} [opts.siteDomain]    Optional site domain — passed to gbpApi for match_score
 * @param {object} [opts.injectedClient] Test seam: replace the gbpApi client with a stub
 *                                       that returns a fixture array of locations.
 * @param {object} [opts.injectedPool]   Test seam: replace getServicesPool() with a stub pool.
 * @returns {Promise<{added:number, updated:number, removed:number, primary:string|null, total:number}>}
 */
export async function syncAllLocations(tenantId, accessToken, opts = {}) {
  if (!tenantId) throw new Error('syncAllLocations: tenantId required');
  if (!accessToken && !opts.injectedClient) throw new Error('syncAllLocations: accessToken required');

  const { siteId = null, siteDomain = null, injectedClient = null, injectedPool = null } = opts;

  // Fetch via real API or injected stub (used by tests / fixtures)
  const fetchLocations = injectedClient
    ? injectedClient
    : (token, domain) => listAllGbpLocations(token, domain);

  const remoteLocations = await fetchLocations(accessToken, siteDomain);
  const remoteList = Array.isArray(remoteLocations) ? remoteLocations : [];

  const pool = injectedPool || (await getServicesPool());

  // Load existing rows so we can compute added / updated / removed.
  const existingResult = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query('SELECT location_id, gbp_location_id, is_primary FROM arion.business_location WHERE tenant_id = @tenantId');

  const existingByGbpId = new Map();
  for (const row of existingResult.recordset) {
    existingByGbpId.set(row.gbp_location_id, row);
  }

  let added = 0;
  let updated = 0;
  const seenGbpIds = new Set();
  let hadPrimary = existingResult.recordset.some((r) => r.is_primary === true || r.is_primary === 1);
  let primaryLocationName = null;

  for (const loc of remoteList) {
    const parsed = parseLocationName(loc.location_name);
    const gbpLocationId = parsed.locationId;
    if (!gbpLocationId) continue; // skip malformed entries — defensive

    seenGbpIds.add(gbpLocationId);

    const fields = mapToColumns(loc, parsed);

    if (existingByGbpId.has(gbpLocationId)) {
      // UPDATE — refresh every field from Google. We treat Google as
      // authoritative for the address/phone/website on each sync; if the
      // tenant has edited the local row we'd lose that, but today the table
      // is write-only from Google (no manual UI yet), so it's safe.
      const req = pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('gbpLocationId', sql.NVarChar(100), gbpLocationId)
        .input('gbpAccountId', sql.NVarChar(100), fields.gbpAccountId)
        .input('locationName', sql.NVarChar(200), fields.locationName)
        .input('displayName', sql.NVarChar(200), fields.displayName)
        .input('addressLine1', sql.NVarChar(500), fields.addressLine1)
        .input('city', sql.NVarChar(100), fields.city)
        .input('region', sql.NVarChar(100), fields.region)
        .input('postalCode', sql.NVarChar(20), fields.postalCode)
        .input('country', sql.NVarChar(2), fields.country)
        .input('phone', sql.NVarChar(50), fields.phone)
        .input('website', sql.NVarChar(500), fields.website)
        .input('primaryCategory', sql.NVarChar(200), fields.primaryCategory)
        .input('placeId', sql.NVarChar(100), fields.placeId)
        .input('reviewUri', sql.NVarChar(500), fields.reviewUri);
      if (siteId) req.input('siteId', sql.UniqueIdentifier, siteId);
      await req.query(`
        UPDATE arion.business_location
        SET gbp_account_id   = @gbpAccountId,
            location_name    = @locationName,
            display_name     = @displayName,
            address_line1    = @addressLine1,
            city             = @city,
            region           = @region,
            postal_code      = @postalCode,
            country          = @country,
            phone            = @phone,
            website          = @website,
            primary_category = @primaryCategory,
            place_id         = @placeId,
            review_uri       = @reviewUri,
            ${siteId ? 'site_id = COALESCE(site_id, @siteId),' : ''}
            last_synced_at   = SYSDATETIMEOFFSET(),
            updated_at       = SYSDATETIMEOFFSET()
        WHERE tenant_id = @tenantId AND gbp_location_id = @gbpLocationId
      `);
      updated += 1;
    } else {
      // INSERT — first time we've seen this listing.
      const shouldBePrimary = !hadPrimary && added === 0;
      const req = pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('gbpLocationId', sql.NVarChar(100), gbpLocationId)
        .input('gbpAccountId', sql.NVarChar(100), fields.gbpAccountId)
        .input('locationName', sql.NVarChar(200), fields.locationName)
        .input('displayName', sql.NVarChar(200), fields.displayName)
        .input('addressLine1', sql.NVarChar(500), fields.addressLine1)
        .input('city', sql.NVarChar(100), fields.city)
        .input('region', sql.NVarChar(100), fields.region)
        .input('postalCode', sql.NVarChar(20), fields.postalCode)
        .input('country', sql.NVarChar(2), fields.country)
        .input('phone', sql.NVarChar(50), fields.phone)
        .input('website', sql.NVarChar(500), fields.website)
        .input('primaryCategory', sql.NVarChar(200), fields.primaryCategory)
        .input('placeId', sql.NVarChar(100), fields.placeId)
        .input('reviewUri', sql.NVarChar(500), fields.reviewUri)
        .input('isPrimary', sql.Bit, shouldBePrimary ? 1 : 0);
      if (siteId) req.input('siteId', sql.UniqueIdentifier, siteId);
      await req.query(`
        INSERT INTO arion.business_location
          (tenant_id, ${siteId ? 'site_id, ' : ''}gbp_account_id, gbp_location_id, location_name,
           display_name, address_line1, city, region, postal_code, country,
           phone, website, primary_category, place_id, review_uri,
           is_primary, last_synced_at)
        VALUES
          (@tenantId, ${siteId ? '@siteId, ' : ''}@gbpAccountId, @gbpLocationId, @locationName,
           @displayName, @addressLine1, @city, @region, @postalCode, @country,
           @phone, @website, @primaryCategory, @placeId, @reviewUri,
           @isPrimary, SYSDATETIMEOFFSET())
      `);
      added += 1;
      if (shouldBePrimary) {
        primaryLocationName = fields.locationName;
        hadPrimary = true;
      }
    }
  }

  // REMOVED — anything we have but Google didn't return is stale.
  // Hard-delete rather than soft-delete: if the user revoked a listing's
  // access we shouldn't keep stale rows around feeding the Portal.
  let removed = 0;
  for (const [gbpId] of existingByGbpId) {
    if (!seenGbpIds.has(gbpId)) {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('gbpLocationId', sql.NVarChar(100), gbpId)
        .query('DELETE FROM arion.business_location WHERE tenant_id = @tenantId AND gbp_location_id = @gbpLocationId');
      removed += 1;
    }
  }

  // If after sync we still have no primary (e.g. all rows pre-existed with
  // is_primary=0), promote the first one alphabetically.
  if (!hadPrimary && remoteList.length > 0) {
    const promoted = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        UPDATE TOP (1) arion.business_location
        SET is_primary = 1, updated_at = SYSDATETIMEOFFSET()
        OUTPUT inserted.location_name
        WHERE tenant_id = @tenantId
          AND is_primary = 0
      `);
    primaryLocationName = promoted.recordset[0]?.location_name || null;
  }

  // Audit breadcrumb to arion.site_integration_status. This is best-effort;
  // a missing migration 017 should not fail the sync.
  if (siteId) {
    try {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('externalRef', sql.NVarChar(200), `synced ${remoteList.length} locations (added=${added}, updated=${updated}, removed=${removed})`)
        .query(`
          MERGE arion.site_integration_status AS target
          USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, 'gbp' AS integration_key) AS src
          ON target.tenant_id = src.tenant_id
            AND target.site_id = src.site_id
            AND target.integration_key = src.integration_key
          WHEN MATCHED THEN
            UPDATE SET status = 'active',
                       external_ref = @externalRef,
                       last_attempt_at = SYSDATETIMEOFFSET(),
                       updated_at = SYSDATETIMEOFFSET()
          WHEN NOT MATCHED THEN
            INSERT (tenant_id, site_id, integration_key, status, external_ref, last_attempt_at)
            VALUES (@tenantId, @siteId, 'gbp', 'active', @externalRef, SYSDATETIMEOFFSET());
        `);
    } catch (auditErr) {
      console.warn('[gbpSync] audit breadcrumb skipped:', auditErr.message);
    }
  }

  return {
    added,
    updated,
    removed,
    total: remoteList.length,
    primary: primaryLocationName,
  };
}

/**
 * Set a specific location as primary for a tenant. Clears the previous
 * primary in a single SQL transaction so we never end up with zero or two.
 *
 * @param {string} tenantId
 * @param {string} locationId — the UNIQUEIDENTIFIER PK of the row
 * @returns {Promise<{primary_location_id:string} | null>} null if not found
 */
export async function setPrimaryLocation(tenantId, locationId) {
  const pool = await getServicesPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const exists = await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('locationId', sql.UniqueIdentifier, locationId)
      .query('SELECT location_id FROM arion.business_location WHERE tenant_id = @tenantId AND location_id = @locationId');
    if (exists.recordset.length === 0) {
      await tx.rollback();
      return null;
    }

    await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('UPDATE arion.business_location SET is_primary = 0, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND is_primary = 1');

    await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('locationId', sql.UniqueIdentifier, locationId)
      .query('UPDATE arion.business_location SET is_primary = 1, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND location_id = @locationId');

    await tx.commit();
    return { primary_location_id: locationId };
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}

/**
 * Parse "accounts/{accountId}/locations/{locationId}" into {accountId, locationId}.
 * Tolerates the location_name field already being only "locations/{l}" or "{l}".
 */
export function parseLocationName(fullName) {
  if (!fullName || typeof fullName !== 'string') return { accountId: null, locationId: null };
  // "accounts/A/locations/L" → accountId=A, locationId=L
  const matchFull = fullName.match(/accounts\/([^/]+)\/locations\/([^/]+)/);
  if (matchFull) return { accountId: matchFull[1], locationId: matchFull[2] };
  // "locations/L" → locationId=L
  const matchLoc = fullName.match(/locations\/([^/]+)/);
  if (matchLoc) return { accountId: null, locationId: matchLoc[1] };
  // bare id
  return { accountId: null, locationId: fullName };
}

/**
 * Convert a gbpApi.listAllGbpLocations entry into the column shape used by
 * arion.business_location. Pulled out so tests can call it directly without
 * a database.
 */
export function mapToColumns(loc, parsed) {
  // Address: gbpApi returns "address" pre-formatted as a single string for the
  // picker. We DO need the structured parts; in v2 we'd pass storefrontAddress
  // through directly. For now, split on commas as a pragmatic mapping — the
  // structured fields are nullable so a partial parse degrades gracefully.
  const addressStr = loc.address || '';
  const parts = addressStr.split(',').map((p) => p.trim()).filter(Boolean);
  let addressLine1 = null;
  let city = null;
  let region = null;
  let postalCode = null;
  if (parts.length === 1) {
    addressLine1 = parts[0];
  } else if (parts.length === 2) {
    addressLine1 = parts[0];
    city = parts[1];
  } else if (parts.length === 3) {
    addressLine1 = parts[0];
    city = parts[1];
    // "ST 12345" → region + postal
    const last = parts[2];
    const m = last.match(/^([A-Za-z .]+?)\s+(\S+)$/);
    if (m) { region = m[1].trim(); postalCode = m[2].trim(); }
    else region = last;
  } else if (parts.length >= 4) {
    addressLine1 = parts.slice(0, parts.length - 3).join(', ');
    city = parts[parts.length - 3];
    region = parts[parts.length - 2];
    postalCode = parts[parts.length - 1];
  }

  return {
    gbpAccountId: parsed.accountId || null,
    locationName: loc.location_name || null,
    displayName: loc.title || null,
    addressLine1,
    city,
    region,
    postalCode,
    country: null, // not in current gbpApi response — left null until v2 plumbing
    phone: loc.primary_phone || null,
    website: loc.website_uri || null,
    primaryCategory: loc.category || null,
    placeId: loc.place_id || null,
    reviewUri: loc.review_uri || null,
  };
}
