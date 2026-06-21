/**
 * Brand context loader for the ARION IL website builder.
 * --------------------------------------------------------------------------
 * Each emitter needs a small bundle of "what is this business" facts:
 *
 *   {
 *     tenant_id,
 *     site_id,
 *     business_name,
 *     industry,
 *     description,
 *     tagline,
 *     target_audience,
 *     services:        [string],
 *     brand_voice,
 *     style_preference,
 *     location,
 *     primary_color,
 *     logo_url,
 *     font_family,
 *     domain
 *   }
 *
 * Sources (in priority order):
 *   1. arion.site.branding_primary_color / branding_logo_url / branding_font_family
 *      — set during provisioning
 *   2. arion.signup_session.questionnaire_json
 *      — JSON answers from the unified onboarding modal
 *      (businessName, industry, tagline, description, targetAudience,
 *       services, brandVoice, stylePreference, location)
 *   3. arion.tenant — for fallback business_name from primary_email if missing
 *
 * Returns a *safe* defaulted object — every field is present (possibly empty
 * string / null), so emitter prompts can interpolate without conditionals.
 */

import sql from 'mssql';

const EMPTY_BRAND = Object.freeze({
  tenant_id:        null,
  site_id:          null,
  business_name:    '',
  industry:         '',
  description:      '',
  tagline:          '',
  target_audience:  '',
  services:         [],
  brand_voice:      'professional',
  style_preference: 'modern',
  location:         '',
  primary_color:    null,
  logo_url:         null,
  font_family:      null,
  domain:           null,
});

function parseJson(maybe) {
  if (!maybe) return null;
  if (typeof maybe === 'object') return maybe;
  try { return JSON.parse(maybe); } catch { return null; }
}

/**
 * Load brand context from the services SQL pool for a given site.
 *
 * @param {import('mssql').ConnectionPool} pool — services pool
 * @param {{ tenantId: string, siteId: string }} args
 * @returns {Promise<typeof EMPTY_BRAND>}
 */
export async function loadBrandContext(pool, { tenantId, siteId }) {
  if (!pool || !tenantId || !siteId) {
    return { ...EMPTY_BRAND, tenant_id: tenantId || null, site_id: siteId || null };
  }

  const siteRow = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId',   sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1
             domain,
             branding_primary_color,
             branding_logo_url,
             branding_font_family
        FROM arion.site
       WHERE tenant_id = @tenantId AND site_id = @siteId
    `);

  if (siteRow.recordset.length === 0) {
    // Site not found / wrong tenant — caller should 404 before this; defensive.
    return { ...EMPTY_BRAND, tenant_id: tenantId, site_id: siteId };
  }
  const site = siteRow.recordset[0];

  // Pull most-recent questionnaire for this site (signup-session row).
  // If the customer re-onboarded, take the latest.
  const qRow = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId',   sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1 questionnaire_json
        FROM arion.signup_session
       WHERE tenant_id = @tenantId AND site_id = @siteId
       ORDER BY session_pk DESC
    `);
  const answers = parseJson(qRow.recordset[0]?.questionnaire_json) || {};

  // Tenant fallback for business name if questionnaire didn't capture it.
  let businessName = answers.businessName || answers.business_name || '';
  if (!businessName) {
    const tRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 primary_email FROM arion.tenant WHERE tenant_id = @tenantId`);
    const email = tRow.recordset[0]?.primary_email || '';
    if (email) businessName = email.split('@')[0] || '';
  }

  const services = Array.isArray(answers.services)
    ? answers.services.map((s) => String(s).trim()).filter(Boolean)
    : [];

  return {
    tenant_id:        tenantId,
    site_id:          siteId,
    business_name:    businessName,
    industry:         answers.industry || '',
    description:      answers.description || '',
    tagline:          answers.tagline || '',
    target_audience:  answers.targetAudience || answers.target_audience || '',
    services,
    brand_voice:      answers.brandVoice || answers.brand_voice || 'professional',
    style_preference: answers.stylePreference || answers.style_preference || 'modern',
    location:         answers.location || '',
    primary_color:    site.branding_primary_color || null,
    logo_url:         site.branding_logo_url || null,
    font_family:      site.branding_font_family || null,
    domain:           site.domain || null,
  };
}

/**
 * Merge a partial brand context override into the loaded baseline. Used when
 * an admin/founder wants to preview an emitter with different brand inputs
 * without persisting them.
 */
export function mergeBrandContext(base, override) {
  if (!override || typeof override !== 'object') return base;
  return { ...base, ...override };
}

export const __test__ = { EMPTY_BRAND };
