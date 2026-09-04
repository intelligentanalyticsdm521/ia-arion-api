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
 *     email,           // the business's notification address (see below)
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
 *   3. arion.tenant — primary_email, used as the fallback business_name AND
 *      as the last-resort notification email
 *
 * `email` is the address every generated form notifies. It was MISSING from
 * this bundle, which is why elementorAdapter's contact form shipped an empty
 * `email_to` on every AI-built page (SCOPE_ARION_SITE_BUILDER_2026-09-05
 * §2.5). Resolution order: the questionnaire answer, then the signup
 * session's own email, then arion.tenant.primary_email. No hardcoded
 * fallback — the adapter refuses to build a form it cannot address.
 *
 * Returns a *safe* defaulted object — every field is present (possibly empty
 * string / null), so emitter prompts can interpolate without conditionals.
 */

import sql from 'mssql';
// Foundation B — the ONE business profile the owner fills in on
// Settings -> Your business. It OUTRANKS the signup questionnaire below: the
// questionnaire is what someone typed once during onboarding, the profile is
// what the owner maintains and every other product reads. Absent, empty or
// unreachable, everything below behaves exactly as it did before.
import { getBusinessProfile } from '../../db/platformPool.js';

const EMPTY_BRAND = Object.freeze({
  tenant_id:        null,
  site_id:          null,
  business_name:    '',
  industry:         '',
  description:      '',
  tagline:          '',
  target_audience:  '',
  services:         [],
  email:            '',
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
      SELECT TOP 1 questionnaire_json, email
        FROM arion.signup_session
       WHERE tenant_id = @tenantId AND site_id = @siteId
       ORDER BY session_pk DESC
    `);
  const answers = parseJson(qRow.recordset[0]?.questionnaire_json) || {};

  let businessName = answers.businessName || answers.business_name || '';

  // The business's own notification address, as stated during onboarding.
  let contactEmail = String(
    answers.contactEmail || answers.contact_email
    || answers.businessEmail || answers.business_email
    || answers.ownerEmail || answers.owner_email
    || answers.email || '',
  ).trim();
  // Next best: the address the signup session itself was created with.
  if (!contactEmail) contactEmail = String(qRow.recordset[0]?.email || '').trim();

  // Tenant fallback — supplies the business name when the questionnaire didn't
  // capture one, and the last-resort notification address.
  if (!businessName || !contactEmail) {
    const tRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 primary_email FROM arion.tenant WHERE tenant_id = @tenantId`);
    const primaryEmail = String(tRow.recordset[0]?.primary_email || '').trim();
    if (!businessName && primaryEmail) businessName = primaryEmail.split('@')[0] || '';
    if (!contactEmail) contactEmail = primaryEmail;
  }

  const services = Array.isArray(answers.services)
    ? answers.services.map((s) => String(s).trim()).filter(Boolean)
    : [];

  // The business profile, when there is one. Never fatal: getBusinessProfile
  // returns null rather than throwing, so a platform-DB hiccup cannot stop a
  // site build (same contract as getSharedProfile beside it).
  const profile = await getBusinessProfile(tenantId);
  const profileServices = profileServiceNames(profile);
  const profileLocation = serviceAreaToLocation(profile);

  return {
    tenant_id:        tenantId,
    site_id:          siteId,
    business_name:    businessName,
    industry:         profile?.industry || answers.industry || '',
    description:      profile?.description || answers.description || '',
    tagline:          profile?.tagline || answers.tagline || '',
    target_audience:  profile?.target_audience || answers.targetAudience || answers.target_audience || '',
    services:         profileServices.length ? profileServices : services,
    email:            contactEmail,
    brand_voice:      profile?.brand_voice || answers.brandVoice || answers.brand_voice || 'professional',
    style_preference: answers.stylePreference || answers.style_preference || 'modern',
    location:         profileLocation || answers.location || '',
    primary_color:    site.branding_primary_color || null,
    logo_url:         site.branding_logo_url || null,
    font_family:      site.branding_font_family || null,
    domain:           site.domain || null,
  };
}


/** services_json ([{name, offering_id}]) -> the string[] the emitters expect. */
function profileServiceNames(profile) {
  const parsed = parseJson(profile?.services_json);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

/** service_area_json -> the one-line "where we work" string emitters render. */
function serviceAreaToLocation(profile) {
  const area = parseJson(profile?.service_area_json);
  if (!area || typeof area !== 'object') return '';
  if (typeof area.note === 'string' && area.note.trim()) return area.note.trim();
  const parts = [...(area.cities || []), ...(area.states || [])]
    .map((v) => String(v).trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : '';
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

export const __test__ = { EMPTY_BRAND, profileServiceNames, serviceAreaToLocation };
