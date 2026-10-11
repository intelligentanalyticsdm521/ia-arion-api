// lib/tierCheck.js — what is left of the old tier helpers: highestBaseTier,
// used by routes/arion/sites.js for the per-tier SITE LIMIT (limits are not
// the feature catalog's job yet). meetsMinTier() and requireTier() were
// deleted on 11 Oct 2026: every feature gate now names a catalog key
// (lib/featureGate.js, middleware/requireFeature.js).
const TIER_LEVELS = { lite: 0, standard: 1, pro: 2, business: 3, enterprise: 4 };

/**
 * Highest KNOWN base ARION tier among several candidate values
 * (arion.tenant.plan, arion.site.arion_tier rows…). SEO add-on words
 * (starter/essentials/growth/authority), empty and unknown values are
 * ignored. Returns null when nothing resolves — callers treat null as
 * UNRESOLVED and never deny on it.
 */
export function highestBaseTier(values) {
  let best = null;
  for (const v of values || []) {
    const k = String(v || '').trim().toLowerCase();
    if (!(k in TIER_LEVELS)) continue;
    if (best === null || TIER_LEVELS[k] > TIER_LEVELS[best]) best = k;
  }
  return best;
}
