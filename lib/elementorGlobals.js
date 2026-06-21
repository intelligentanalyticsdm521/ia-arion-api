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
 * Fallback (Elementor versions where the v1/globals endpoint is GET-only or
 * the namespace isn't registered — empirically the POST returns 404 on every
 * site we provision):
 *   `wp option get elementor_active_kit`                              → kit ID
 *   `wp post meta get <kit_id> _elementor_page_settings --format=json` → JSON
 *   merge payload.system_colors + system_typography into that JSON
 *   `wp post meta update <kit_id> _elementor_page_settings <json>`
 *   `wp eval "do_action('elementor/core/files/clear_cache');"`
 * This module DOES shell out via lib/hostingerSsh.runWpCli when the REST POST
 * 404s — the helper is `applyGlobalsViaWpCli({domain,payload})`. It's called
 * automatically from setElementorGlobals's 404 branch unless the caller
 * passes `disableWpCliFallback: true`. Inject `runWpCli` to mock the SSH
 * path in a verifier.
 *
 * Inject `fetchImpl` to mock the HTTP path in a verifier.
 */

import { buildPluginAuth, resolveSiteHost } from './pluginClient.js';
import { runWpCli as defaultRunWpCli } from './hostingerSsh.js';

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
 * @param {function} [params.runWpCli]     inject runWpCli for testing the
 *                                          wp-cli fallback path. Defaults to
 *                                          hostingerSsh.runWpCli.
 * @param {boolean} [params.disableWpCliFallback]
 *                                         when true, a 404 from the REST
 *                                          endpoint returns fallback_required
 *                                          instead of automatically running
 *                                          the wp-cli path. Default false —
 *                                          we always try the SSH fallback.
 * @returns {Promise<{ ok: boolean, applied: string[], httpStatus?: number,
 *                     error?: string, fallback_required?: boolean,
 *                     via?: string, payload?: object }>}
 *   `applied` lists which globals were written: 'colors', 'typography'.
 *   `via` = 'rest' on the happy REST path, 'wp_cli' when we dropped down to
 *   SSH because Elementor's REST POST 404'd.
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
  // registered (POST is gone — the endpoint is GET-only on the installed
  // Elementor version). Drop down to wp-cli over SSH so brand colors and
  // typography still apply on the customer's site instead of silently
  // erroring out of onboarding.
  if (res.status === 404) {
    if (params.disableWpCliFallback) {
      return {
        ok: false,
        applied: [],
        httpStatus: 404,
        error: 'elementor_globals_endpoint_not_available',
        fallback_required: true,
        payload,
      };
    }
    try {
      const cliResult = await applyGlobalsViaWpCli({
        domain:   host,
        payload,
        runWpCli: params.runWpCli || defaultRunWpCli,
      });
      if (cliResult.ok) {
        return {
          ok:       true,
          applied:  ['colors', 'typography'],
          via:      'wp_cli',
          httpStatus: 404,
          payload,
        };
      }
      return {
        ok:        false,
        applied:   [],
        httpStatus: 404,
        error:     `wp_cli_fallback_failed: ${cliResult.error || 'unknown'}`,
        fallback_required: true,
        payload,
      };
    } catch (cliErr) {
      return {
        ok:        false,
        applied:   [],
        httpStatus: 404,
        error:     `wp_cli_fallback_threw: ${(cliErr.message || '').slice(0, 300)}`,
        fallback_required: true,
        payload,
      };
    }
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
    via: 'rest',
    httpStatus: res.status,
    payload,
    raw: parsed?.data ?? parsed ?? null,
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * wp-cli fallback for setElementorGlobals. Used when Elementor's REST POST
 * /wp-json/elementor/v1/globals returns 404 (the installed Elementor version
 * exposes the endpoint as GET-only, or Pro is disabled, or the namespace was
 * never registered).
 *
 * Flow:
 *   1. `wp option get elementor_active_kit` → kit post ID.
 *   2. `wp post meta get <kit_id> _elementor_page_settings --format=json`
 *      → current kit settings JSON (system_colors / system_typography live
 *      here on the Elementor Kit CPT).
 *   3. Merge payload.system_colors + payload.system_typography into that
 *      JSON, replacing entries by `_id` (primary/secondary/accent/text).
 *   4. `wp post meta update <kit_id> _elementor_page_settings <json>`
 *      writes it back.
 *   5. `wp eval "do_action('elementor/core/files/clear_cache');"` flushes
 *      Elementor's generated CSS so the new colors render on next page load.
 *
 * Returns `{ ok, kit_id, applied, error? }`. Caller decides whether to treat
 * a non-ok result as fatal — onboarding logs a warning and keeps going.
 *
 * @param {object} params
 * @param {string} params.domain   customer domain (no protocol)
 * @param {object} params.payload  the same payload buildGlobalsPayload() returns
 * @param {function} [params.runWpCli]  inject for testing
 * @param {object} [params.sshCreds]    accepted but currently unused —
 *                                       hostingerSsh.runWpCli pulls SSH creds
 *                                       from Key Vault internally. Reserved
 *                                       for future per-tenant overrides.
 */
export async function applyGlobalsViaWpCli({ domain, payload, runWpCli, sshCreds } = {}) {
  void sshCreds; // reserved — runWpCli sources creds from KV
  const wp = runWpCli || defaultRunWpCli;
  if (!domain) return { ok: false, error: 'no_domain' };
  if (!payload) return { ok: false, error: 'no_payload' };

  // 1. Active kit post ID.
  let kitId;
  try {
    const r = await wp(domain, `option get elementor_active_kit`);
    kitId = String((r.stdout || '').trim());
    if (!kitId || !/^\d+$/.test(kitId)) {
      return { ok: false, error: `bad_active_kit_id: ${kitId.slice(0, 60)}` };
    }
  } catch (err) {
    return { ok: false, error: `get_active_kit_failed: ${(err.message || '').slice(0, 240)}` };
  }

  // 2. Current kit page settings JSON. May be empty on a brand-new kit; that's
  //    fine — we just start from an empty object.
  let current = {};
  try {
    const r = await wp(domain, `post meta get ${kitId} _elementor_page_settings --format=json`);
    const raw = (r.stdout || '').trim();
    if (raw) {
      try { current = JSON.parse(raw) || {}; }
      catch { current = {}; } // corrupted meta — overwrite from payload
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  } catch (err) {
    // Meta key not present yet → wp-cli throws. Treat as empty.
    //
    // Three flavors we have to absorb here (the Elementor 4.1.4 fresh-kit
    // case is the third — wp-cli exits 1 with completely empty stdout AND
    // stderr because the meta row simply doesn't exist on the post yet):
    //   (a) older wp-cli: stderr = "Could not get meta. Meta not found."
    //   (b) newer wp-cli: stderr = "" but stdout = "" with exit 1
    //   (c) some shells: stderr "Error: ..."
    // Treat empty-out + empty-err + non-zero exit as "meta absent" and
    // start from {} — same as case (a). Only a real signal in stderr OR
    // a non-empty stdout that fails to parse counts as a real error.
    const msg     = (err.stderr || err.message || '').toString();
    const stdout  = (err.stdout || '').toString();
    const stderr  = (err.stderr || '').toString();
    const emptyOutput = !stdout.trim() && !stderr.trim();
    const looksLikeAbsent = /not (set|found|exist)|no such meta|could not get meta/i.test(msg);
    if (!emptyOutput && !looksLikeAbsent) {
      // Real error — surface it.
      return { ok: false, kit_id: kitId, error: `get_kit_meta_failed: ${msg.slice(0, 240)}` };
    }
  }

  // 3. Merge by _id so we don't blow away other system colors the customer
  //    may have customized in wp-admin.
  const merged = { ...current };
  if (Array.isArray(payload.system_colors)) {
    const existing = Array.isArray(merged.system_colors) ? merged.system_colors : [];
    merged.system_colors = mergeById(existing, payload.system_colors);
  }
  if (Array.isArray(payload.system_typography)) {
    const existing = Array.isArray(merged.system_typography) ? merged.system_typography : [];
    merged.system_typography = mergeById(existing, payload.system_typography);
  }

  // 4. Write back. wp post meta update needs the JSON as a single shell arg;
  //    escapeShellArg() single-quotes the whole thing and escapes embedded
  //    single quotes the same way hostingerSsh.escapeArg does. We can't use
  //    hostingerSsh.escapeArg directly (not exported), so inline the rule.
  const json = JSON.stringify(merged);
  try {
    await wp(domain, `post meta update ${kitId} _elementor_page_settings ${shellQuote(json)}`);
  } catch (err) {
    return { ok: false, kit_id: kitId, error: `update_kit_meta_failed: ${(err.stderr || err.message || '').toString().slice(0, 240)}` };
  }

  // 5. Clear Elementor's generated CSS cache so the new global colors render.
  //    Best-effort — if the action hook isn't registered (e.g. Elementor not
  //    loaded), don't fail the whole apply.
  try {
    await wp(domain, `eval ${shellQuote(`do_action('elementor/core/files/clear_cache');`)}`);
  } catch (err) {
    console.warn(`[elementorGlobals] clear_cache eval failed (non-fatal): ${(err.message || '').slice(0, 200)}`);
  }

  return {
    ok:      true,
    kit_id:  kitId,
    applied: ['colors', 'typography'],
    via:     'wp_cli',
  };
}

/**
 * Merge two arrays of `{ _id, ... }` objects, with `incoming` winning on
 * matching `_id`. Order-preserving on the existing array, with any new
 * incoming entries appended.
 */
function mergeById(existing, incoming) {
  const byId = new Map();
  for (const item of existing) {
    if (item && item._id) byId.set(item._id, item);
  }
  for (const item of incoming) {
    if (item && item._id) byId.set(item._id, { ...byId.get(item._id), ...item });
  }
  return Array.from(byId.values());
}

/** Single-quote a string for safe POSIX shell embedding. */
function shellQuote(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

export const __test__ = {
  ELEMENTOR_GLOBALS_PATH,
  DEFAULT_TEXT_COLOR,
  HEADING_FONTS,
  BODY_FONTS,
  CREATIVE_VERTICALS,
};
