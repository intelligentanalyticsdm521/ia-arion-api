/**
 * Pricing — IADM plan catalog and price math.
 * --------------------------------------------------------------------------
 * Source of truth for plan prices. Annual = monthly × 12 × 0.90 (10% off).
 * No other discounts. Domain markup is independent — see lib/hostinger.js.
 *
 * "First year free on annual" is implemented at Stripe checkout time as a
 * one-time discount applied to the domain line item only — the recurring
 * subscription remains billed normally.
 *
 * Stripe price IDs are NOT hardcoded here; they live in env vars per
 * environment (test / prod) so we can rotate them without code changes:
 *
 *   STRIPE_PRICE_STARTER_MONTHLY
 *   STRIPE_PRICE_STARTER_ANNUAL
 *   STRIPE_PRICE_ESSENTIALS_MONTHLY
 *   STRIPE_PRICE_ESSENTIALS_ANNUAL
 *   STRIPE_PRICE_GROWTH_MONTHLY
 *   STRIPE_PRICE_GROWTH_ANNUAL
 *   STRIPE_PRICE_AUTHORITY_MONTHLY
 *   STRIPE_PRICE_AUTHORITY_ANNUAL
 *   STRIPE_DOMAIN_FREE_FIRST_YEAR_COUPON  — coupon applied to domain line on annual signups
 */

export const ANNUAL_DISCOUNT = 0.10;

export const PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'IA Plugin only — basic content + analytics',
    monthly_usd: 29,
    features: ['IA Plugin', 'Basic CWV monitoring', 'Up to 10 keyword tracking'],
  },
  {
    key: 'essentials',
    name: 'Essentials',
    description: 'Adds GA4, Search Console, Bing Webmaster',
    monthly_usd: 49,
    features: ['Everything in Starter', 'GA4', 'Search Console', 'Bing Webmaster', '25 keyword tracking'],
  },
  {
    key: 'growth',
    name: 'Growth',
    description: 'Adds SE Ranking, Google Business Profile, Market Monitor lite',
    monthly_usd: 99,
    features: ['Everything in Essentials', 'SE Ranking 6-layer', 'GBP', 'AI Search Results (Google AI Mode)', '60 keyword tracking'],
  },
  {
    key: 'authority',
    name: 'Authority',
    description: 'Full Market Monitor + AI search (ChatGPT + Gemini)',
    monthly_usd: 199,
    features: ['Everything in Growth', 'Market Monitor (10+20 pages)', 'ChatGPT + Gemini AI search', '150 keyword tracking'],
  },
];

/**
 * Compute annual price (10% off monthly × 12), rounded to 2 decimals.
 */
export function annualPrice(monthly) {
  const raw = monthly * 12 * (1 - ANNUAL_DISCOUNT);
  return Math.round(raw * 100) / 100;
}

/**
 * Get a plan by key with prices and Stripe price IDs included.
 * Returns null for unknown keys.
 */
export function getPlan(key) {
  const plan = PLANS.find((p) => p.key === String(key).toLowerCase());
  if (!plan) return null;
  const annual = annualPrice(plan.monthly_usd);
  return {
    ...plan,
    annual_usd: annual,
    annual_per_month_usd: Math.round((annual / 12) * 100) / 100,
    stripe_price_monthly: process.env[`STRIPE_PRICE_${plan.key.toUpperCase()}_MONTHLY`] || null,
    stripe_price_annual: process.env[`STRIPE_PRICE_${plan.key.toUpperCase()}_ANNUAL`] || null,
  };
}

/**
 * Public catalog used by the signup UI's plan picker.
 */
export function getCatalog() {
  return PLANS.map((p) => {
    const annual = annualPrice(p.monthly_usd);
    return {
      key: p.key,
      name: p.name,
      description: p.description,
      features: p.features,
      pricing: {
        monthly_usd: p.monthly_usd,
        annual_usd: annual,
        annual_per_month_usd: Math.round((annual / 12) * 100) / 100,
        annual_savings_usd: Math.round((p.monthly_usd * 12 - annual) * 100) / 100,
      },
    };
  });
}

/**
 * Resolve the Stripe price ID for a (plan, billing_cycle) pair.
 * @param {string} planKey  starter|essentials|growth|authority
 * @param {string} cycle    monthly|annual
 * @returns {string|null}
 */
export function getStripePriceId(planKey, cycle) {
  const plan = getPlan(planKey);
  if (!plan) return null;
  return cycle === 'annual' ? plan.stripe_price_annual : plan.stripe_price_monthly;
}
