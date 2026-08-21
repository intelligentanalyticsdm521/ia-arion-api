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

export function meetsMinTier(currentTier, requiredTier) {
  const current = TIER_LEVELS[(currentTier || 'lite').toLowerCase()] ?? 0;
  const required = TIER_LEVELS[(requiredTier || 'lite').toLowerCase()] ?? 0;
  return current >= required;
}

export function requireTier(minTier) {
  return (req, res, next) => {
    const siteTier = req.siteRecord?.arion_tier || 'lite';
    if (!meetsMinTier(siteTier, minTier)) {
      return res.status(402).json({
        error: {
          code: 'TIER_LIMIT_REACHED',
          message: `This feature requires ${minTier} tier or above`,
          status: 402,
          upgrade: { current_tier: siteTier, required_tier: minTier }
        }
      });
    }
    next();
  };
}
