/**
 * The brand kit — our brand as an Elementor kit, and the ONE way we write it.
 * --------------------------------------------------------------------------
 * D-81 (2026-09-09). This module used to write the kit with wp-cli over
 * Hostinger SSH. That path has NEVER worked on a single site:
 *
 *   - it read the option `elementor_active_kit_id`, which Elementor does not
 *     define (the real one is `elementor_active_kit`), so every run fell into
 *     the "fresh kit" branch;
 *   - it then patched `_elementor_data` on the kit post, where a kit's
 *     settings do not live (`_elementor_page_settings` does), so even when it
 *     reported `ok: true` nothing reached the rendered CSS;
 *   - and it needed SSH, so a BYO-hosted site could not be branded at all.
 *
 * Both facts were verified against Elementor 4.2 in the dev container while
 * building ARION pack 2, which is where the working writer came from: the IA
 * plugin's `POST /site/kit` asks Elementor itself which kit is live, writes
 * the meta that kit reads, flushes the generated CSS, and READS THE VALUES
 * BACK, refusing to report a save that did not land.
 *
 * So there is now ONE write path to WordPress — the plugin — and this module
 * is the shape of the payload plus the call. It never touches SSH.
 *
 * `buildGlobalsPayload` stays exactly as it was: it is the ONE description of
 * "our brand as an Elementor kit", and `routes/arion/website.js` uses it to
 * offer the client a suggestion in the Portal. `kitBodyFromGlobals` is the
 * only new thing — it renames that shape into the plugin route's body.
 */

import { writeKit as defaultWriteKit } from './websiteBuilder/pageClient.js';

// Default "Text" colour — neutral near-black used by every Elementor Kit out
// of the box. Brandon's scope calls for primary/secondary/accent + text;
// we don't ask Claude for a text colour, we just pin it to this.
const DEFAULT_TEXT_COLOR = '#111827';

// Curated font allowlist (per V2 scope). Keep tiny — every font added here
// has to be loaded by Elementor's font manager + Google Fonts. Don't expand
// without Brandon's sign-off.
const HEADING_FONTS = ['Inter', 'Plus Jakarta Sans'];
const BODY_FONTS    = ['Inter', 'IBM Plex Sans'];

// Industry verticals → font pairing. Service businesses get the neutral
// system-feel pairing (Inter/Inter); creative / lifestyle verticals get the
// slightly more characterful Plus Jakarta heading. Deterministic so two
// runs of the orchestrator pick the same pair.
const CREATIVE_VERTICALS = new Set([
  'creative', 'design', 'photography', 'art', 'studio',
  'restaurant', 'hospitality', 'fashion', 'beauty', 'wellness',
]);

/** A kit write goes to a live website; give it the write timeout, not the read one. */
const KIT_WRITE_TIMEOUT_MS = 45_000;

/**
 * Choose a default heading + body font pair from the allowlist based on the
 * site's industry vertical. Exported for verifier use.
 *
 * @param {string} [vertical] free-text vertical e.g. 'industrial-cleaning'
 * @returns {{ heading: string, body: string }}
 */
export function pickDefaultFonts(vertical) {
  const v = String(vertical || '').toLowerCase();
  const isCreative = [...CREATIVE_VERTICALS].some((t) => v.includes(t));
  return {
    heading: isCreative ? 'Plus Jakarta Sans' : 'Inter',
    body:    isCreative ? 'IBM Plex Sans'    : 'Inter',
  };
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}
function normalizeHex(v, fallback) {
  return isHexColor(v) ? v.trim() : fallback;
}
function normalizeFont(v, allowlist, fallback) {
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  if (!t) return fallback;
  // Allow any string but log if it's outside the curated set — the caller
  // is responsible for making sure Elementor has the font registered.
  return allowlist.includes(t) ? t : t;
}

/**
 * Build the Elementor Globals payload.
 *
 * Shape per V2 scope: one `system_colors` array with four named entries
 * (primary/secondary/accent/text), one `system_typography` array with two
 * named entries (primary = heading, secondary = body).
 *
 * Exported for verifier use.
 */
export function buildGlobalsPayload({
  brandName,
  primaryColor,
  secondaryColor,
  accentColor,
  headingFont,
  bodyFont,
}) {
  return {
    _id: 'globals',
    title: brandName ? `${brandName} brand globals` : 'Brand globals',
    system_colors: [
      { _id: 'primary',   title: 'Primary',   color: primaryColor },
      { _id: 'secondary', title: 'Secondary', color: secondaryColor },
      { _id: 'accent',    title: 'Accent',    color: accentColor },
      { _id: 'text',      title: 'Text',      color: DEFAULT_TEXT_COLOR },
    ],
    system_typography: [
      {
        _id: 'primary',
        title: 'Heading',
        typography_typography:        'custom',
        typography_font_family:       headingFont,
        typography_font_weight:       '700',
      },
      {
        _id: 'secondary',
        title: 'Body',
        typography_typography:        'custom',
        typography_font_family:       bodyFont,
        typography_font_weight:       '400',
      },
    ],
  };
}

/**
 * The same brand, in the words the plugin's `POST /site/kit` route speaks.
 *
 * The Elementor-kit shape (`_id`, `typography_font_family`) is Elementor's;
 * the route's shape (`id`, `font_family`) is ours. Renaming here rather than
 * building a second payload keeps `buildGlobalsPayload` the only description
 * of what our brand IS.
 *
 * @param {object} payload  the result of buildGlobalsPayload
 * @returns {{ colors: Array<{id:string,color:string}>,
 *             typography: Array<{id:string,font_family:string,font_weight:string}> }}
 */
export function kitBodyFromGlobals(payload) {
  const colors = (payload?.system_colors || [])
    .filter((c) => c && c._id && c.color)
    .map((c) => ({ id: String(c._id), color: String(c.color) }));
  const typography = (payload?.system_typography || [])
    .filter((t) => t && t._id && t.typography_font_family)
    .map((t) => ({
      id:          String(t._id),
      font_family: String(t.typography_font_family),
      font_weight: String(t.typography_font_weight || ''),
    }));
  return { colors, typography };
}

/**
 * Write the brand kit onto a site, through the IA plugin.
 *
 * @param {object}  params
 * @param {object}  params.site           the site to write to. Anything
 *   `buildPluginAuth` accepts: an `arion.site` row with `site_token_raw`, or
 *   the onboarding shim carrying `wp_app_password_ref`. Without one of those
 *   there is no way in, and we say so rather than guessing.
 * @param {string} [params.domain]        used when `site` carries no domain.
 * @param {string} [params.brandName]     labels the kit.
 * @param {string}  params.primaryColor   hex (#RRGGBB)
 * @param {string}  params.secondaryColor hex (#RRGGBB)
 * @param {string}  params.accentColor    hex (#RRGGBB)
 * @param {string} [params.headingFont]   optional, defaults via pickDefaultFonts
 * @param {string} [params.bodyFont]      optional, defaults via pickDefaultFonts
 * @param {string} [params.vertical]      used when font params omitted
 * @param {function} [params.writeKit]    inject the transport for testing.
 * @returns {Promise<{ ok: boolean, applied: string[], via?: string,
 *                     kit_id?: number, error?: string, message?: string,
 *                     payload?: object }>}
 *   `applied` lists which globals landed: 'colors', 'typography'.
 *   `via` = 'plugin' on success.
 */
export async function setElementorGlobals(params = {}) {
  // A site row is how we authenticate. Accept a bare domain for callers that
  // only have one, but never invent credentials.
  const site = params.site
    || (params.domain ? { domain: String(params.domain) } : null);
  if (!site) {
    return { ok: false, applied: [], error: 'no_domain_for_site' };
  }

  // Colours missing entirely is a hard fail — we won't invent a brand for the
  // customer. Fonts can fall back to the curated allowlist.
  const primary   = normalizeHex(params.primaryColor,   null);
  const secondary = normalizeHex(params.secondaryColor, null);
  const accent    = normalizeHex(params.accentColor,    null);
  if (!primary || !secondary || !accent) {
    return { ok: false, applied: [], error: 'missing_or_invalid_brand_colors' };
  }

  const defaults = pickDefaultFonts(params.vertical);
  const headingFont = normalizeFont(params.headingFont, HEADING_FONTS, defaults.heading);
  const bodyFont    = normalizeFont(params.bodyFont,    BODY_FONTS,    defaults.body);

  const payload = buildGlobalsPayload({
    brandName:      params.brandName,
    primaryColor:   primary,
    secondaryColor: secondary,
    accentColor:    accent,
    headingFont,
    bodyFont,
  });

  const write = params.writeKit || defaultWriteKit;
  const result = await write(site, kitBodyFromGlobals(payload), {
    timeoutMs: KIT_WRITE_TIMEOUT_MS,
  });

  // The plugin reads the kit back before it answers, so a 200 here means the
  // colours are on the kit Elementor renders from. Anything else is a
  // failure and is reported as one — never a swallowed warning that lets the
  // dashboard show a green tick over an unbranded site
  // (memory: reference_catch_swallow_report_success).
  if (!result?.ok) {
    return {
      ok:      false,
      applied: [],
      error:   result?.error || 'kit_write_failed',
      message: result?.message || result?.data?.error || null,
      status:  result?.status ?? 0,
      payload,
    };
  }

  return {
    ok:      true,
    applied: ['colors', 'typography'],
    via:     'plugin',
    kit_id:  Number(result.data?.kit_id) || null,
    payload,
  };
}

export const __test__ = {
  DEFAULT_TEXT_COLOR,
  HEADING_FONTS,
  BODY_FONTS,
  CREATIVE_VERTICALS,
  KIT_WRITE_TIMEOUT_MS,
};
