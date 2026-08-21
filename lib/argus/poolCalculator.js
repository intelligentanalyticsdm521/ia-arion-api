// ARGUS AI credit pool calculator (LOCKED 2026-06-24 by Brandon:
// Standard drops to 0 entirely; Pro 50 base + 10 stacking; Business 150 base + 15 stacking).
//
// Pool = base tier (highest across products) + bonus per additional platform.
// Lite and Standard contribute 0.
//
// Per-tenant, not per-product. Multi-product savings live in the MP5R coupon (5% for any 2+ platforms; MP7R retired 2026-08-21).
//
// Expected tier vocab in core.tenants.subscription_tier:
//   "lite" | "standard" | "pro" | "business" | "starter" | "essentials" |
//   "growth" | "authority" (the ARION SEO ladder maps onto our 4 tiers via
//   the legend below — keeps existing data working).

const TIER_LEGEND = {
  lite:       "lite",
  starter:    "lite",
  standard:   "standard",
  essentials: "standard",
  pro:        "pro",
  growth:     "pro",
  business:   "business",
  authority:  "business",
};

export const TIER_BASE_CREDITS = {
  lite:     0,
  standard: 0,
  pro:      50,
  business: 150,
};

export const TIER_BONUS_CREDITS = {
  lite:     0,
  standard: 0,
  pro:      10,
  business: 15,
};

function normalizeTier(raw) {
  const t = String(raw || "").toLowerCase().trim();
  return TIER_LEGEND[t] || "lite";
}

/**
 * Calculate monthly credit allocation for a tenant.
 *
 * @param {string[]} productTiers - One tier name per subscribed product
 *   e.g. ["business", "pro", "standard"] for ARION Business + OLIVER Pro + SPARK Standard.
 *   Empty array → returns 0.
 * @returns {{ monthly_credits: number, base: number, bonus: number, base_tier: string, count: number }}
 */
export function calculatePool(productTiers) {
  const normed = (productTiers || []).map(normalizeTier).filter(Boolean);
  if (normed.length === 0) {
    return { monthly_credits: 0, base: 0, bonus: 0, base_tier: "lite", count: 0 };
  }

  const tierRank = { lite: 0, standard: 1, pro: 2, business: 3 };
  let highest = normed[0];
  for (const t of normed) if (tierRank[t] > tierRank[highest]) highest = t;

  const base = TIER_BASE_CREDITS[highest] || 0;

  // Bonus: ALL OTHER tiers (everything except one — the one carrying the base).
  // We remove ONE instance of the highest tier (the "base earner") then sum the
  // bonus for every remaining product based on its own tier.
  const remaining = [...normed];
  const i = remaining.indexOf(highest);
  if (i >= 0) remaining.splice(i, 1);

  const bonus = remaining.reduce((sum, t) => sum + (TIER_BONUS_CREDITS[t] || 0), 0);

  return {
    monthly_credits: base + bonus,
    base,
    bonus,
    base_tier: highest,
    count: normed.length,
  };
}
