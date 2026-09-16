// lib/brandKitClient.js — arion's thin client for the ONE brand kit.
//
// BUILDER_PLATFORM_SCOPE_2026-09-15 §2, step 0. The kit itself lives in
// platform-api `lib/brandKit.js` and is served at GET /internal/brand-kit/:tenantId.
// NOTHING IN THIS FILE DECIDES WHAT A BUSINESS LOOKS LIKE. If you find yourself
// adding a `||` with a hex colour in it here, you are building the fifth store.
//
// Built to the same shape as lib/businessIdentityClient.js on purpose: same
// 60-second TTL, same stale-on-failure rule, same "never throws" contract.
//
// WHY ARION NEEDED THIS MOST. arion.site.branding_primary_color /
// branding_logo_url / branding_font_family were written ONCE at provisioning
// and never again, and loadBrandContext read nothing else — so a client could
// edit Brand Identity every day and their website kept the colour they were
// given on day one. pageAssembler even emitted --ia-secondary and --ia-accent
// CSS variables that brandContext had no way to fill: two dead branches,
// shipped. The kit fills all four.
//
// ── WHY 60 SECONDS IS SAFE HERE ───────────────────────────────────────────
// Seams pack 2 deleted the notification gate's cache because a cached
// PERMISSION outlived a bounce webhook. A COLOUR is not a permission: it
// changes when its owner edits Brand Identity, and the cost of being one
// minute stale is one minute of the old colour. Same TTL, same reasoning, as
// the identity client and platform-api's own entitlement cache.
//
// ── STALE-ON-FAILURE IS DELIBERATE ────────────────────────────────────────
// If platform-api cannot answer, this returns the LAST KNOWN kit for that
// business, flagged `stale: true`, and logs. Only if there has never been one
// does it fall back to the NEUTRAL kit. A page assembled during a blip must
// not be injected into a live site in slate — and the 503 the route answers on a
// database failure (as opposed to the 200 + neutral it answers for a business
// that genuinely has no brand) is what makes telling those apart possible.
//
// REQUIRES: PLATFORM_API_URL and PLATFORM_INTERNAL_TOKEN (SEAM-11, read only
// through lib/platformEnv.js).

import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

/** THE neutral default, byte-identical to platform-api's NEUTRAL_BRAND_KIT and
 *  to oliver's, LUMEN's and the Portal's copies. Pinned by a test in each repo.
 *  Slate, never Intelligent Analytics' own navy/gold/orange. */
export const NEUTRAL_BRAND_COLOURS = Object.freeze({
  primary: "#0F172A",
  secondary: "#475569",
  accent: "#334155",
  text: "#111827",
  background: "#FFFFFF",
});

export const BRAND_KIT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;

/** tenantId(lower) -> { kit, at } */
const _cache = new Map();
const CACHE_MAX = 500;

/** The shape a caller gets when we have never had an answer for this business. */
export function neutralBrandKit(tenantId) {
  return {
    tenant_id: String(tenantId || ""),
    found: false,
    colours: { ...NEUTRAL_BRAND_COLOURS },
    fonts: { heading: "Inter", body: "Inter", catalog: [] },
    logo_url: null,
    updated_at: null,
    sources: {},
    neutral: true,
    source: "unavailable",
  };
}

export function clearBrandKitCache() { _cache.clear(); }

function cacheSet(key, kit, at) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { kit, at });
}

/**
 * The business's brand kit. Never throws, never rejects.
 *
 * @param {string} tenantId
 * @param {{fetchImpl?:Function, now?:Function, log?:object}} [opts]
 * @returns {Promise<object>} always a kit; check `.source` and `.stale` when
 *   you care whether it is fresh, and `.found` when you care whether the
 *   business has a brand at all.
 */
export async function getBrandKit(tenantId, opts = {}) {
  const key = String(tenantId || "").trim().toLowerCase();
  if (!key) return neutralBrandKit(tenantId);

  const now = opts.now || Date.now;
  const log = opts.log || console;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < BRAND_KIT_TTL_MS) return hit.kit;

  const base = platformApiUrl();
  const token = platformInternalToken();
  const doFetch = opts.fetchImpl || globalThis.fetch;

  const degrade = (reason) => {
    if (hit) {
      // Last known good, deliberately NOT re-dated: the entry keeps its
      // original timestamp so the next call retries rather than settling into
      // a stale brand for the life of the process.
      log.warn?.(`[brandKit] ${reason} for ${key} — serving the last known kit`);
      return { ...hit.kit, stale: true, source: "stale-cache" };
    }
    log.warn?.(`[brandKit] ${reason} for ${key} — no cached kit, using the neutral one`);
    return neutralBrandKit(tenantId);
  };

  if (!base || !token) return degrade("PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not configured");

  let res;
  try {
    res = await doFetch(`${base}/internal/brand-kit/${encodeURIComponent(key)}`, {
      headers: { "x-internal-token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return degrade(`unreachable (${e?.message || e})`);
  }
  if (!res.ok) return degrade(`HTTP ${res.status}`);

  let kit;
  try {
    kit = await res.json();
  } catch (e) {
    return degrade(`unreadable body (${e?.message || e})`);
  }
  if (!kit || !kit.colours || typeof kit.colours.primary !== "string") {
    return degrade("response carried no colours");
  }

  const shaped = { ...kit, stale: false, source: kit.found ? "platform" : "platform-neutral" };
  cacheSet(key, shaped, now());
  return shaped;
}

export default { getBrandKit, neutralBrandKit, clearBrandKitCache, NEUTRAL_BRAND_COLOURS, BRAND_KIT_TTL_MS };
