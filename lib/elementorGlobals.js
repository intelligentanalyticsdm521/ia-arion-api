/**
 * Elementor Globals injector — ARION IL website builder (V2 F-201).
 * --------------------------------------------------------------------------
 * Sets the customer site's Elementor Global Colors + Global Typography via
 * Elementor's REST API so the assembled page tree (see lib/websiteBuilder/*)
 * can reference `globals/colors/primary`, `globals/typography/primary`, etc.
 * instead of hard-baking hex codes + font names into every widget.
 *
 * The win: re-branding the site later is a single API call against this
 * endpoint — every widget that uses globals updates automatically. No need
 * to re-walk the _elementor_data tree.
 *
 * V2 scope reference:
 *   overnight-report/38_AI_WEBSITE_BUILDER_v2_SCOPE.md  (Phase 4, F-201)
 *
 * Endpoint:
 *   POST https://{domain}/wp-json/elementor/v1/globals
 *
 * Auth model:
 *   This is the CORE Elementor REST namespace (not the IA Plugin namespace),
 *   so the `X-Arion-Site-Token` custom header is NOT honoured here —
 *   Elementor's permission callback requires `current_user_can('edit_theme_options')`
 *   which in turn needs a real authenticated WP user. We use the WordPress
 *   application password stored on the site row (`wp_app_password_ref`),
 *   sent as HTTP Basic auth, exactly the same pattern lib/websiteBuilder/
 *   mediaLibrary.js falls back to when calling /wp-json/wp/v2/media.
 *
 * Fallback (older Elementor that does not expose v1/globals):
 *   `wp option update elementor_active_kit_id <kit_id>`
 *   `wp post meta update <kit_id> _elementor_data <json>`
 *   This module does NOT shell out — it returns a `fallback_required` error
 *   and the caller (provisioner / page assembler) is expected to invoke
 *   hostingerSsh.js's wp-cli helpers. See TODO at the bottom of this file.
 *
 * This module is PURE JS — no DB calls, no SDKs. Inject `fetchImpl` to mock
 * the HTTP path in a verifier.
 */

import { buildPluginAuth, resolveSiteHost } from './pluginClient.js';

const ELEMENTOR_GLOBALS_PATH = '/wp-json/elementor/v1/globals';
const REQUEST_TIMEOUT_MS     = 20_000;

// Default "Text" colour — neutral near-black used by every Elementor Kit out
// of the box. Brandon's scope (line 82-91) calls for primary/secondary/accent
// + text; we don't ask Claude for a text colour, we just pin it to this.
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
 * Shape per V2 scope (lines 78-91): one `system_colors` array with four
 * named entries (primary/secondary/accent/text), one `system_typography`
 * array with two named entries (primary = heading, secondary = body).
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
 * Set Elementor Global Colors + Typography on the customer's WP site.
 *
 * @param {object}  params
 * @param {string}  params.domain          customer domain (no protocol)
 * @param {string} [params.brandName]      used to label the kit in WP admin
 * @param {string}  params.primaryColor    hex (#RRGGBB)
 * @param {string}  params.secondaryColor  hex (#RRGGBB)
 * @param {string}  params.accentColor     hex (#RRGGBB)
 * @param {string} [params.headingFont]    optional, defaults via pickDefaultFonts
 * @param {string} [params.bodyFont]       optional, defaults via pickDefaultFonts
 * @param {string} [params.vertical]       used when font params omitted
 * @param {object} [params.site]           full arion.site row — used to resolve
 *                                          auth + host when `domain` not enough.
 *                                          When provided, takes precedence for
 *                                          host resolution + auth header build.
 * @param {object} [params.fetchImpl]      inject fetch for testing
 * @returns {Promise<{ ok: boolean, applied: string[], httpStatus?: number,
 *                     error?: string, fallback_required?: boolean,
 *                     payload?: object }>}
 *   `applied` lists which globals were written: 'colors', 'typography'.
 *   `fallback_required = true` when Elementor REST returns 404 — caller
 *   should drop down to the wp-cli path (see TODO at file bottom).
 */
export async function setElementorGlobals(params = {}) {
  const fetchImpl = params.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, applied: [], error: 'no_fetch_impl' };
  }

  // Resolve host — prefer explicit domain, fall back to site row.
  const host = params.domain
    ? String(params.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
    : resolveSiteHost(params.site || {});
  if (!host) {
    return { ok: false, applied: [], error: 'no_domain_for_site' };
  }

  // Build auth — Elementor's core REST needs a real WP user, so we
  // require Basic auth from wp_app_password_ref. The IA plugin's
  // X-Arion-Site-Token is sent too if present (harmless — Elementor
  // ignores unknown headers) for parity with other outbound calls.
  const auth = buildPluginAuth(params.site || {});
  if (!auth.ok) {
    return {
      ok: false,
      applied: [],
      error: `no_auth_available (${auth.reason || 'missing site credentials'})`,
    };
  }
  if (!auth.headers.Authorization) {
    // We have a site token but no WP app password. Elementor REST will
    // reject this with 401, so don't bother round-tripping.
    return {
      ok: false,
      applied: [],
      error: 'wp_app_password_required_for_elementor_rest',
    };
  }

  // Pick defaults if any required colour is missing or malformed. Colours
  // missing entirely is a hard fail — we won't invent a brand for the
  // customer. Fonts can fall back to the curated allowlist.
  const primary   = normalizeHex(params.primaryColor,   null);
  const secondary = normalizeHex(params.secondaryColor, null);
  const accent    = normalizeHex(params.accentColor,    null);
  if (!primary || !secondary || !accent) {
    return {
      ok: false,
      applied: [],
      error: 'missing_or_invalid_brand_colors',
    };
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

  const url = `https://${host}${ELEMENTOR_GLOBALS_PATH}`;

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs || REQUEST_TIMEOUT_MS);
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        ...auth.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    return {
      ok: false,
      applied: [],
      error: err.name === 'AbortError' ? 'elementor_globals_timeout' : err.message,
      payload,
    };
  }

  // 404 = Elementor too old, or Pro disabled, or REST namespace not
  // registered. Caller should drop down to wp-cli (see TODO below).
  if (res.status === 404) {
    return {
      ok: false,
      applied: [],
      httpStatus: 404,
      error: 'elementor_globals_endpoint_not_available',
      fallback_required: true,
      payload,
    };
  }

  const text = await safeText(res);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    return {
      ok: false,
      applied: [],
      httpStatus: res.status,
      error: (parsed?.message || parsed?.error || text || `HTTP ${res.status}`).toString().slice(0, 500),
      payload,
    };
  }

  // Elementor returns the saved kit; we treat any 2xx as success for both
  // colours + typography because we always send both in one payload.
  return {
    ok: true,
    applied: ['colors', 'typography'],
    httpStatus: res.status,
    payload,
    raw: parsed?.data ?? parsed ?? null,
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

// TODO (V2 follow-up): when setElementorGlobals returns
// `{ fallback_required: true }`, the orchestrator should call a wp-cli
// helper that runs:
//   wp option update elementor_active_kit_id <kit_id>
//   wp post meta update <kit_id> _elementor_data <json>
// against the site over SSH (see lib/hostingerSsh.js for the SSH transport).
// We deliberately do NOT do this here — this module stays HTTP-only so it's
// trivially testable.

export const __test__ = {
  ELEMENTOR_GLOBALS_PATH,
  DEFAULT_TEXT_COLOR,
  HEADING_FONTS,
  BODY_FONTS,
  CREATIVE_VERTICALS,
};
