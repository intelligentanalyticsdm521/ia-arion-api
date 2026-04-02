const TIER_LEVELS = { lite: 0, standard: 1, pro: 2, business: 3, enterprise: 4 };

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
