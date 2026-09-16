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
 *     primary_color, secondary_color, accent_color,
 *     logo_url,
 *     font_family, heading_font,
 *     brand_kit_source,   // 'kit' | 'site' | 'none'
 *     domain
 *   }
 *
 * Sources (in priority order):
 *   0. THE BRAND KIT — platform-api GET /internal/brand-kit, the one object
 *      Brand Identity writes (BUILDER_PLATFORM_SCOPE_2026-09-15 §2, step 0).
 *      Added 2026-09-15 and put FIRST because sources 1 below is a snapshot: a
 *      client could edit their colours every day and this file never saw it.
 *   1. arion.site.branding_primary_color / branding_logo_url / branding_font_family
 *      — set during provisioning, never written since; now the FALLBACK only.
 *      What that table STORES is unchanged in step 0; folding it into the kit
 *      is recorded in the scope doc §2.
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
import { tenantOwnsService } from '../coreTenants.js';
// THE ONE PRICE SOURCE for anything the website says a job costs.
import { loadServicePrices } from './servicePricing.js';
import { firePlatformEvent } from '../platformEvents.js';
// Foundation B — the ONE business profile the owner fills in on
// Settings -> Your business. It OUTRANKS the signup questionnaire below: the
// questionnaire is what someone typed once during onboarding, the profile is
// what the owner maintains and every other product reads. Absent, empty or
// unreachable, everything below behaves exactly as it did before.
import { getBusinessProfile, getPlatformPool } from '../../db/platformPool.js';
// SEAM-10-A - the ONE answer to "what is this business called". PRE-WALK 2
// found the twelfth chain right here; see the client's header for what it did
// to a client's own contact form.
import { resolveBusinessName, BUSINESS_NAME_NOT_SET } from '../businessName.js';
// THE brand kit. arion.site.branding_* was written once at provisioning and
// never again, so a client's website kept day-one colours forever
// (BUILDER_PLATFORM_SCOPE_2026-09-15 §2, step 0). The site columns are still
// READ as the fallback; nothing about what they STORE changes here.
import { getBrandKit } from '../brandKitClient.js';

/**
 * Where a "Book online" button should point, when the business has somewhere
 * for it to point (Ops B6 / step B5).
 * ---------------------------------------------------------------------------
 * `https://book.ia-dm.com/<tenant slug>/` — the BUSINESS IS IN THE PATH.
 *
 * ── SEAMS PACK 4B, 2026-09-06 ────────────────────────────────────────────
 * This used to emit `https://<tenant slug>.book.ia-dm.com/`, the SUBDOMAIN
 * form, and that link has never resolved for a real client: there is no
 * `*.book.ia-dm.com` binding in DNS — the code merely reserved the pattern —
 * and the Static Web App custom-domain cap (~5 per app) is why APP-1 chose the
 * path model in the first place. So every "Book online" button ARION has ever
 * written into a client's website pointed at a hostname that does not exist.
 *
 * The apps merged today (Q-APPS-PWA): oliver-api routes/booking.js
 * buildBookingUrl already emits the path form, and lib/appQr.appUrlFor builds
 * the same shape for all three apps. This is the last emitter that did not.
 * The old subdomain form still 301s (SEAM-5-B), but a link that has to be
 * redirected spends one navigation outside the install scope — and this is the
 * link that gets baked into a published page and copied onto a flyer.
 *
 * Still the ROOT and not a page slug, on purpose: the booking app's index
 * redirects to the single page when there is one and lists them when there are
 * several (oliver-ops/src/App.tsx:39), so the root is correct whether the
 * business runs one booking page or five, and it does not go stale when a page
 * is renamed.
 *
 * The suffix is read from the environment so dev and UAT can differ, exactly
 * as oliver-api reads it (routes/booking.js:46).
 */
const BOOKING_HOSTNAME_SUFFIX = String(
  process.env.BOOKING_HOSTNAME_SUFFIX || 'book.ia-dm.com',
).replace(/^https?:\/\//, '').replace(/\/$/, '');

/** What a surface prints when the business has no recorded name. NOT a name:
 *  a builder that prints "Your Service Provider" as a site's BRAND has
 *  invented one, which is the whole reason the twelfth chain was a defect.
 *
 *  DEFINED IN `lib/businessName.js` and re-exported here so the callers that
 *  already import it from this module keep working, and so there is exactly one
 *  of it. Two copies of a sentence is how two copies of a rule start. */
export { BUSINESS_NAME_NOT_SET };

const EMPTY_BRAND = Object.freeze({
  tenant_id:        null,
  site_id:          null,
  business_name:    '',
  business_name_status: 'not_set',
  industry:         '',
  description:      '',
  tagline:          '',
  target_audience:  '',
  services:         [],
  // The one price list: [{ offering_id, name, description, price, period, features }]
  service_prices:   [],
  service_prices_source: 'no_service_catalogue',
  email:            '',
  brand_voice:      'professional',
  style_preference: 'modern',
  location:         '',
  primary_color:    null,
  // buildBrandCssVars (pageAssembler.js) has emitted --ia-secondary and
  // --ia-accent since it was written and EMPTY_BRAND never carried either, so
  // both were dead branches that could not fire. The kit fills them.
  secondary_color:  null,
  accent_color:     null,
  logo_url:         null,
  font_family:      null,
  heading_font:     null,
  // 'kit' | 'site' | 'none' — which store answered. A surface that shows a
  // colour can say where it came from instead of implying a choice.
  brand_kit_source: 'none',
  domain:           null,
  booking_href:     '',
});

/**
 * Tell the founder that a site is being built for a business with no recorded
 * name. Best effort in every direction: a site build must never fail because
 * we could not file a notice, and the notice must not be filed once per read -
 * a bounded in-process set keeps it to once per (business, site) per process.
 */
const _nameNoticeSent = new Set();
const NAME_NOTICE_MAX = 500;
export function _resetBusinessNameNotices() { _nameNoticeSent.clear(); }

async function reportMissingBusinessName(pool, tenantId, siteId, identity) {
  const reason = identity && identity.stale ? 'identity_unavailable' : 'no_recorded_name';
  console.error(
    `[brandContext] ${tenantId} site ${siteId}: no recorded business name (${reason}) - `
    + `the site will read "${BUSINESS_NAME_NOT_SET}" rather than a guess`,
  );
  const key = `${tenantId}|${siteId}`;
  if (_nameNoticeSent.has(key)) return;
  if (_nameNoticeSent.size >= NAME_NOTICE_MAX) _nameNoticeSent.clear();
  _nameNoticeSent.add(key);
  try {
    await firePlatformEvent(pool, {
      tenantId,
      eventType: 'arion.brand.business_name_missing',
      payload: { site_id: siteId, reason, neutral_text: BUSINESS_NAME_NOT_SET },
      eventRefId: siteId,
    });
  } catch (e) {
    console.error(`[brandContext] could not file the missing-name notice for ${tenantId}: ${e.message}`);
  }
}

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

  // THE brand kit — one call, never throws. `found` false means the business
  // genuinely has no brand recorded, which is a different fact from a platform
  // we could not reach (that comes back as source 'stale-cache' with the last
  // known kit). Either way the arion.site columns stay as the fallback.
  const kit = await getBrandKit(tenantId);
  const kitAnswered = !!kit && (kit.found || kit.source === 'stale-cache');

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

  // -- THE BUSINESS'S NAME: ONE SOURCE, NO CHAIN --------------------------
  //
  // PRE-WALK 2 (2026-09-07). This used to read the ARION onboarding
  // questionnaire's `businessName`, then fall back to the part of the tenant's
  // email address before the @ -- the TWELFTH name chain on the platform, and
  // the only one whose last resort INVENTS a name. `hello@...` became a
  // business called "hello", on its own published website. And on the dev
  // database the questionnaire held another business's fixture, so Summit
  // Lawn's own section library came back branded "Fernbrook Garden Rooms" with
  // hello@fernbrook.invalid in the "Enquiries go to" box (walk rows D3, S3-7).
  //
  // It asks the ONE resolver now. There is no `||` after it: seams pack 4b made
  // platform-api's lib/businessIdentity.js the answer to this question for
  // every product, and a second opinion here is how twelve chains happened.
  //
  // A business with NO recorded name is a real answer, and the answer is not a
  // name: `business_name` stays empty, `business_name_status` says `not_set`,
  // and the surfaces render the sentence rather than guessing. The founder is
  // told through the platform event stream -- a site published under a made-up
  // brand is not something to leave in a log line nobody reads.
  //
  // 2026-09-08: the lookup itself moved to `lib/businessName.js` so that the
  // FOUR readers PRE-WALK 2 left behind — the onboarding driver's brand object,
  // the FAQ topic seed, the Hostinger fallback pages, the copy bundle and the
  // image prompts — ask the same question the same way instead of reading
  // `answers.businessName` off the questionnaire.
  const resolved = await resolveBusinessName(tenantId);
  const businessName = resolved.name;
  const businessNameStatus = resolved.status;
  if (businessNameStatus !== 'set') {
    await reportMissingBusinessName(pool, tenantId, siteId, resolved.identity);
  }
  const identity = resolved.identity;

  // -- HOW ENQUIRIES REACH THEM -------------------------------------------
  // Same rule, one step softer: the business RECORD wins, because that is the
  // address the owner maintains and every other product mails. What somebody
  // typed into the onboarding questionnaire is the fallback for a business
  // whose record has no address on it -- it is still their own answer, it is
  // just the older one. (On dev it was another business's, which is exactly
  // why it is second and not first.)
  let contactEmail = String(identity?.support_email || identity?.email || '').trim();
  if (!contactEmail) {
    contactEmail = String(
      answers.contactEmail || answers.contact_email
      || answers.businessEmail || answers.business_email
      || answers.ownerEmail || answers.owner_email
      || answers.email || '',
    ).trim();
  }
  // Next best: the address the signup session itself was created with.
  if (!contactEmail) contactEmail = String(qRow.recordset[0]?.email || '').trim();
  // Last: whatever the ARION tenant row carries. Never split for a name.
  if (!contactEmail) {
    const tRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 primary_email FROM arion.tenant WHERE tenant_id = @tenantId`);
    contactEmail = String(tRow.recordset[0]?.primary_email || '').trim();
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

  const bookingHref = await resolveBookingHref(pool, tenantId);

  // ARION pack 2 - the business's OWN services and prices, so a pricing
  // section is built from the one price list rather than typed a second time.
  // Fails closed to an empty list (no OLIVER, or an unreadable catalogue), and
  // the pricing starter then shows prompts rather than an invented price.
  const priceList = await loadServicePrices(pool, tenantId);

  return {
    tenant_id:        tenantId,
    site_id:          siteId,
    business_name:    businessName,
    // 'set' | 'not_set' | 'unknown' (the resolver could not be reached and we
    // have never had an answer). A surface renders BUSINESS_NAME_NOT_SET for
    // anything but 'set' - it never renders a guess.
    business_name_status: businessNameStatus,
    industry:         profile?.industry || answers.industry || '',
    description:      profile?.description || answers.description || '',
    tagline:          profile?.tagline || answers.tagline || '',
    target_audience:  profile?.target_audience || answers.targetAudience || answers.target_audience || '',
    services:         profileServices.length ? profileServices : services,
    email:            contactEmail,
    brand_voice:      profile?.brand_voice || answers.brandVoice || answers.brand_voice || 'professional',
    style_preference: answers.stylePreference || answers.style_preference || 'modern',
    location:         profileLocation || answers.location || '',
    // THE brand kit first, arion.site second. The site columns were stamped at
    // provisioning and nothing has written them since, so preferring them is
    // what made Brand Identity invisible to a client's own website.
    primary_color:    kit.colours?.primary   || site.branding_primary_color || null,
    secondary_color:  kit.colours?.secondary || null,
    accent_color:     kit.colours?.accent    || null,
    logo_url:         kit.logo_url           || site.branding_logo_url || null,
    font_family:      kit.fonts?.body        || site.branding_font_family || null,
    heading_font:     kit.fonts?.heading     || null,
    brand_kit_source: kitAnswered ? 'kit' : (site.branding_primary_color ? 'site' : 'none'),
    domain:           site.domain || null,
    booking_href:     bookingHref,
    service_prices:   priceList.services,
    service_prices_source: priceList.ok ? 'catalogue' : priceList.reason,
  };
}

/**
 * The tenant's own online-booking address, or '' when they have none.
 *
 * Two conditions, both required (SCOPE_OPERATIONS_GAPS_2026-09-04 §3.1.5):
 *   1. the tenant OWNS OLIVER — `core.tenant_services` on the platform DB,
 *      asked through `tenantOwnsService` so no service_id is hardcoded
 *      (convention_never_hardcode_service_ids);
 *   2. there is at least one ACTIVE `oliver.booking_page` — a tenant who owns
 *      OLIVER but has not set a booking page up has nowhere to send anybody.
 *
 * FAILS CLOSED, like `tenantOwnsService` itself: "we could not tell" means no
 * button. A CTA pointing at a booking page that does not exist is worse than
 * a CTA pointing at the contact form, which is what the emitters fall back to
 * (`ctaEmitter.js`: `ctx.booking_href || '#contact'`).
 *
 * @returns {Promise<string>} an https URL, or ''
 */
export async function resolveBookingHref(pool, tenantId) {
  if (!pool || !tenantId) return '';
  try {
    const owns = await tenantOwnsService(tenantId, 'oliver');
    if (!owns) return '';

    // The booking pages live in the SAME database this pool is on
    // (iadm_services) — a plain SELECT, no cross-database query.
    const pageRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 1 AS has_page
          FROM oliver.booking_page
         WHERE tenant_id = @tenantId AND is_active = 1
      `);
    if (pageRow.recordset.length === 0) return '';

    const slug = await tenantSlug(tenantId);
    return bookingUrlFor(slug);
  } catch (err) {
    console.warn(`[brandContext] booking_href unavailable for ${tenantId}:`, err?.message);
    return '';
  }
}

/**
 * The booking address for a tenant slug, or '' when the slug is unusable.
 *
 * The slug is now a PATH SEGMENT rather than a hostname label, but it is still
 * validated the same narrow way. A slug containing a dot, a slash or a `..`
 * would build a URL pointing somewhere else entirely, and this string is
 * interpolated straight into a published page — so the check stays on the
 * PRESENCE of an allowed shape, never on the absence of a bad one. The pattern
 * is the same one oliver-api's lib/appQr.appUrlFor uses for the same job.
 */
export function bookingUrlFor(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s)) return '';
  return `https://${BOOKING_HOSTNAME_SUFFIX}/${s}/`;
}

/** core.tenants.slug — the subdomain the booking app is served from. */
async function tenantSlug(tenantId) {
  const platformPool = await getPlatformPool();
  const r = await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query('SELECT TOP 1 slug FROM core.tenants WHERE tenant_id = @tid');
  return String(r.recordset[0]?.slug || '').trim();
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

export const __test__ = {
  EMPTY_BRAND, profileServiceNames, serviceAreaToLocation, BOOKING_HOSTNAME_SUFFIX,
};
