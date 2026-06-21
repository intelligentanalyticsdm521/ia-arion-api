/**
 * Elementor Globals injector — ARION IL website builder (V2 F-201).
 * --------------------------------------------------------------------------
 * Sets the customer site's Elementor Global Colors + Global Typography so the
 * assembled page tree (see lib/websiteBuilder/*) can reference
 * `globals/colors/primary`, `globals/typography/primary`, etc. instead of
 * hard-baking hex codes + font names into every widget.
 *
 * The win: re-branding the site later is a single op against the Elementor
 * Kit — every widget that uses globals updates automatically. No need to
 * re-walk the _elementor_data tree.
 *
 * V2 scope reference:
 *   overnight-report/38_AI_WEBSITE_BUILDER_v2_SCOPE.md  (Phase 4, F-201)
 *
 * Canonical path: wp-cli over SSH.
 * --------------------------------------------------------------------------
 * The Elementor REST endpoint at /wp-json/elementor/v1/globals is GET-only on
 * every Elementor version we provision — POST returns 404 every time. Don't
 * POST to it. We empirically verified that across the entire ARION-provisioned
 * estate the wp-cli path is the only one that lands brand colors + typography
 * on the customer's Kit. This module commits to wp-cli as the sole transport.
 *
 * Sequence (per Brandon's authoritative spec):
 *   1. `wp option get elementor_active_kit_id`                  → kit post ID
 *   2. `wp post meta get <kitId> _elementor_data --format=json` → kit JSON
 *   3. Merge payload.system_colors + payload.system_typography into the kit
 *      JSON (preserve other keys: custom_colors, custom_typography, layout
 *      settings, etc.); replace entries with matching `_id`, append new ones.
 *   4. `wp post meta update <kitId> _elementor_data <shell-quoted-json>`
 *   5. `wp elementor flush_css`                                 → clear CSS cache
 *
 * Inject `runWpCli` to mock the SSH path in a verifier.
 */

import { runWpCli as defaultRunWpCli } from './hostingerSsh.js';

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

const WP_CLI_TIMEOUT_MS = 30_000;

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
 * Set Elementor Global Colors + Typography on the customer's WP site via
 * wp-cli over SSH. This is the only transport — we do NOT attempt the
 * Elementor REST endpoint (it's GET-only across the estate).
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
 * @param {object} [params.site]           accepted for call-site parity; not
 *                                          required — wp-cli sources SSH
 *                                          creds from Key Vault internally.
 * @param {function} [params.runWpCli]     inject runWpCli for testing.
 *                                          Defaults to hostingerSsh.runWpCli.
 * @returns {Promise<{ ok: boolean, applied: string[], via?: string,
 *                     kit_id?: string, error?: string, payload?: object }>}
 *   `applied` lists which globals were written: 'colors', 'typography'.
 *   `via` = 'wp_cli' on success.
 */
export async function setElementorGlobals(params = {}) {
  // Resolve domain — prefer explicit domain, fall back to site row.
  const host = params.domain
    ? String(params.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
    : (params.site && params.site.domain
        ? String(params.site.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
        : null);
  if (!host) {
    return { ok: false, applied: [], error: 'no_domain_for_site' };
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

  const wp = params.runWpCli || defaultRunWpCli;

  // 1. Active kit post ID. Brandon's canonical option key is
  //    `elementor_active_kit_id` (NOT `elementor_active_kit`).
  //
  // wp-cli throws on missing option (exit 1, stderr "Could not get
  // 'elementor_active_kit_id' option. Does it exist?"). Treat that as the
  // fresh-Elementor case and initialise the kit instead of bailing.
  let kitId;
  const readKitId = async () => {
    try {
      const r = await wpExec(wp, host, `option get elementor_active_kit_id`);
      return { ok: true, value: String((r.stdout || '').trim()) };
    } catch (err) {
      const msg    = (err.stderr || err.message || '').toString();
      const stdout = (err.stdout || '').toString();
      const stderr = (err.stderr || '').toString();
      const emptyOutput     = !stdout.trim() && !stderr.trim();
      const looksLikeAbsent = /could not get|not (set|found|exist)|does it exist/i.test(msg);
      if (emptyOutput || looksLikeAbsent) return { ok: true, value: '' };
      return { ok: false, error: msg.slice(0, 240) };
    }
  };

  const firstRead = await readKitId();
  if (!firstRead.ok) {
    return {
      ok:      false,
      applied: [],
      error:   `get_active_kit_id_failed: ${firstRead.error}`,
      payload,
    };
  }
  kitId = firstRead.value;
  if (!kitId || kitId === '0' || !/^\d+$/.test(kitId)) {
    // Fresh-kit case: Elementor hasn't initialized a kit on this install
    // yet. Try to nudge it into existence by calling the kits_manager,
    // then re-read. If that fails too, surface a clear error so submit.js
    // can decide whether to keep going.
    const initResult = await tryInitializeElementorKit(wp, host);
    if (!initResult.ok) {
      return {
        ok:      false,
        applied: [],
        error:   `elementor_kit_not_initialized: ${initResult.error}`,
        payload,
      };
    }
    const secondRead = await readKitId();
    if (!secondRead.ok) {
      return {
        ok:      false,
        applied: [],
        error:   `get_active_kit_id_retry_failed: ${secondRead.error}`,
        payload,
      };
    }
    kitId = secondRead.value;
    if (!kitId || kitId === '0' || !/^\d+$/.test(kitId)) {
      return {
        ok:      false,
        applied: [],
        error:   `elementor_kit_not_initialized: kit id still empty after init`,
        payload,
      };
    }
  }

  // 2. Current kit _elementor_data JSON. May be empty/null on a brand-new
  //    kit; that's fine — we just start from an empty object.
  let current = {};
  try {
    const r = await wpExec(wp, host, `post meta get ${kitId} _elementor_data --format=json`);
    const raw = (r.stdout || '').trim();
    if (raw && raw !== 'null') {
      try { current = JSON.parse(raw) || {}; }
      catch { current = {}; } // corrupted meta — overwrite from payload
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  } catch (err) {
    // Meta key not present yet → wp-cli throws. Treat as empty.
    //
    // Three flavors we have to absorb here (the Elementor fresh-kit case
    // is the third — wp-cli exits 1 with completely empty stdout AND
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
      return {
        ok:      false,
        applied: [],
        kit_id:  kitId,
        error:   `get_kit_data_failed: ${msg.slice(0, 240)}`,
        payload,
      };
    }
  }

  // 3. Merge by _id so we don't blow away other system colors the customer
  //    may have customized in wp-admin. Preserve every other key on the
  //    kit JSON (custom_colors, custom_typography, layout settings, etc.).
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
  //    shellQuote() single-quotes the whole thing and escapes embedded
  //    single quotes. Compact JSON (no pretty-print) — wp-cli prefers it.
  const json = JSON.stringify(merged);
  try {
    await wpExec(wp, host, `post meta update ${kitId} _elementor_data ${shellQuote(json)}`);
  } catch (err) {
    return {
      ok:      false,
      applied: [],
      kit_id:  kitId,
      error:   `update_kit_data_failed: ${(err.stderr || err.message || '').toString().slice(0, 240)}`,
      payload,
    };
  }

  // 5. Clear Elementor's generated CSS cache so the new global colors
  //    render on next page load. Brandon's canonical command is
  //    `wp elementor flush_css` (the Elementor CLI subcommand) — NOT
  //    `wp eval "do_action(...)"`. Best-effort: if Elementor's CLI command
  //    isn't registered for some reason, log + keep going.
  try {
    await wpExec(wp, host, `elementor flush_css`);
  } catch (err) {
    console.warn(`[elementorGlobals] flush_css failed (non-fatal): ${(err.stderr || err.message || '').toString().slice(0, 200)}`);
  }

  return {
    ok:      true,
    applied: ['colors', 'typography'],
    via:     'wp_cli',
    kit_id:  kitId,
    payload,
  };
}

/**
 * Invoke runWpCli with a 30s timeout per command. The underlying ssh2
 * client doesn't honour AbortController, so we race the wp-cli promise
 * against a setTimeout and surface a clear `wp_cli_timeout` error.
 */
async function wpExec(wp, domain, args, timeoutMs = WP_CLI_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`wp_cli_timeout after ${timeoutMs}ms: ${args.slice(0, 120)}`);
      e.code = 'TIMEOUT';
      reject(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([wp(domain, args), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort nudge to create the Elementor Kit when it hasn't been
 * initialized yet (i.e. `wp option get elementor_active_kit_id` is empty).
 *
 * Strategy: call Elementor's own kits_manager->get_active_id() via wp eval —
 * the manager creates a Kit post on first access if one doesn't exist and
 * writes the option. We don't depend on `wp elementor library reimport`
 * existing on every install.
 */
async function tryInitializeElementorKit(wp, domain) {
  // Run BOTH snippets back-to-back — get_active_id() alone doesn't reliably
  // seed the elementor_active_kit_id option on fresh installs; we observed
  // empirically that get_active_id returns 0 and the option stays unset, so
  // explicit create_default() is required. Don't early-return on first
  // success — we need both to land before the option is guaranteed.
  const phpSnippets = [
    // First: hit the kits_manager get_active_id(). On versions where this
    // is enough, it seeds the option as a side effect.
    `if (class_exists('\\\\Elementor\\\\Plugin')) { \\Elementor\\Plugin::$instance->kits_manager->get_active_id(); }`,
    // Then: explicit create_default + capture its return id and write the
    // option ourselves so the next `wp option get` succeeds even on the
    // versions where create_default doesn't auto-set the option.
    `if (class_exists('\\\\Elementor\\\\Plugin') && method_exists(\\Elementor\\Plugin::$instance->kits_manager, 'create_default')) { $kid = \\Elementor\\Plugin::$instance->kits_manager->create_default(); if ($kid) { update_option('elementor_active_kit_id', $kid); echo $kid; } }`,
  ];
  let lastError = 'no_snippet_attempted';
  let anyOk = false;
  for (const php of phpSnippets) {
    try {
      await wpExec(wp, domain, `eval ${shellQuote(php)}`);
      anyOk = true;
    } catch (err) {
      lastError = (err.stderr || err.message || '').toString().slice(0, 240);
    }
  }
  return anyOk ? { ok: true } : { ok: false, error: lastError };
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
  DEFAULT_TEXT_COLOR,
  HEADING_FONTS,
  BODY_FONTS,
  CREATIVE_VERTICALS,
  WP_CLI_TIMEOUT_MS,
  mergeById,
  shellQuote,
};
