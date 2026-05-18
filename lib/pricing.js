/**
 * Pricing — IADM multi-product plan catalog and price math.
 * --------------------------------------------------------------------------
 * Source of truth for SELF-SERVE signup plan prices. Annual = monthly × 12 ×
 * 0.90 (10% off). Stripe price IDs are NEVER hardcoded — they live in env
 * vars per environment so they can be rotated without code changes.
 *
 * Product-aware (added 2026-05-18 for unified signup). BACKWARD COMPATIBLE:
 * every legacy single-arg ARION call still works unchanged.
 *
 * Env var name pattern (create the Stripe recurring Prices, then set these):
 *   STRIPE_PRICE_<PRODUCT>_<PLAN>_<CYCLE>
 *     e.g. STRIPE_PRICE_OLIVER_STANDARD_MONTHLY
 *          STRIPE_PRICE_SPARK_PRO_ANNUAL
 *   ARION also falls back to the legacy un-prefixed names so existing prod
 *   config keeps working:
 *     STRIPE_PRICE_<PLAN>_<CYCLE>  (e.g. STRIPE_PRICE_GROWTH_MONTHLY)
 *   Plus the domain free-first-year coupon (ARION only):
 *     STRIPE_DOMAIN_FREE_FIRST_YEAR_COUPON
 */

export const ANNUAL_DISCOUNT = 0.10;

export const PRODUCTS = ['arion', 'oliver', 'spark'];
const DEFAULT_PRODUCT = 'arion';

// ── ARION (unchanged) ──────────────────────────────────────────────────────
const ARION_PLANS = [
  { key: 'starter',    name: 'Starter',    description: 'IA Plugin only — basic content + analytics',
    monthly_usd: 29,  features: ['IA Plugin', 'Basic CWV monitoring', 'Up to 10 keyword tracking'] },
  { key: 'essentials', name: 'Essentials', description: 'Adds GA4, Search Console, Bing Webmaster',
    monthly_usd: 49,  features: ['Everything in Starter', 'GA4', 'Search Console', 'Bing Webmaster', '25 keyword tracking'] },
  { key: 'growth',     name: 'Growth',     description: 'Adds SE Ranking, Google Business Profile, Market Monitor lite',
    monthly_usd: 99,  features: ['Everything in Essentials', 'SE Ranking 6-layer', 'GBP', 'AI Search Results (Google AI Mode)', '60 keyword tracking'] },
  { key: 'authority',  name: 'Authority',  description: 'Full Market Monitor + AI search (ChatGPT + Gemini)',
    monthly_usd: 199, features: ['Everything in Growth', 'Market Monitor (10+20 pages)', 'ChatGPT + Gemini AI search', '150 keyword tracking'] },
];

// ── OLIVER (canonical base ladder — Enterprise is contact-sales, not here) ──
const OLIVER_PLANS = [
  { key: 'lite',     name: 'Lite',     description: 'Solo operator — you do the steps',
    monthly_usd: 29,  features: ['1 seat', '50 jobs/mo', 'Manual quotes/invoices + Stripe', 'View & pay customer portal', 'Catalog (25 items)'] },
  { key: 'standard', name: 'Standard', description: 'Small team — it does it for you',
    monthly_usd: 39,  features: ['5 seats', 'Unlimited jobs', 'Recurring (approval queue)', 'Workflow templates', 'Dispatch + job offers'] },
  { key: 'pro',      name: 'Pro',      description: 'Growing operation',
    monthly_usd: 69,  features: ['10 seats', 'Auto-scheduled recurring', 'Multi-option quoting', 'Time + expense tracking', 'Branded proposals + e-sign'] },
  { key: 'business', name: 'Business', description: 'Multi-location operators',
    monthly_usd: 129, features: ['25 seats', 'Job costing + margin', 'Territories + SLA', 'BNPL / financing', 'Connect contractor payouts'] },
];

// ── SPARK (Phase-1 self-serve: base 5k-email tier + feature add-on) ─────────
// Standard = 5k base ($19). Pro = base + Pro add-on ($19+$49=$68).
// Business = base + Business add-on ($19+$89=$108). Volume is adjustable in
// Settings post-signup (do not put the full volume slider in signup).
const SPARK_PLANS = [
  { key: 'standard', name: 'Standard', description: 'CRM essentials — 5,000 emails/mo to start',
    monthly_usd: 19,  features: ['Full CRM + contacts', 'Email + SMS campaigns', 'Forms + UTM tracking', 'ARION form → SPARK auto-flow', '5k emails / 1k contacts (adjustable)'] },
  { key: 'pro',      name: 'Pro',      description: 'Marketing power tools',
    monthly_usd: 68,  features: ['Everything in Standard', 'Sales Pipeline + Deals', 'Newsletter Studio + WP publish', 'Social scheduler', 'Landing pages, NPS, referrals'] },
  { key: 'business', name: 'Business', description: 'Pro + AI + B2B',
    monthly_usd: 108, features: ['Everything in Pro', 'AI Writer (full)', 'OLIVER-cross segments', 'Revenue attribution', 'B2B companies + account reporting'] },
];

const CATALOGS = { arion: ARION_PLANS, oliver: OLIVER_PLANS, spark: SPARK_PLANS };

// Legacy calls pass a plan key as the first arg; new calls pass a product.
// Detect: if the first arg is a known product, it's product-scoped.
function splitArgs(a, b) {
  if (typeof a === 'string' && PRODUCTS.includes(a.toLowerCase())) {
    return { product: a.toLowerCase(), key: b };
  }
  return { product: DEFAULT_PRODUCT, key: a };
}

export function annualPrice(monthly) {
  return Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT) * 100) / 100;
}

function resolveStripePrice(product, planKey, cycle) {
  const P = product.toUpperCase();
  const K = String(planKey).toUpperCase();
  const C = cycle === 'annual' ? 'ANNUAL' : 'MONTHLY';
  // Preferred: product-scoped env var.
  const scoped = process.env[`STRIPE_PRICE_${P}_${K}_${C}`];
  if (scoped) return scoped;
  // Legacy fallback for ARION only (un-prefixed names already in prod).
  if (product === 'arion') return process.env[`STRIPE_PRICE_${K}_${C}`] || null;
  return null;
}

/**
 * getPlan(key)                 — legacy, ARION
 * getPlan(product, key)        — product-aware
 */
export function getPlan(a, b) {
  const { product, key } = splitArgs(a, b);
  const list = CATALOGS[product] || [];
  const plan = list.find((p) => p.key === String(key).toLowerCase());
  if (!plan) return null;
  const annual = annualPrice(plan.monthly_usd);
  return {
    ...plan,
    product,
    annual_usd: annual,
    annual_per_month_usd: Math.round((annual / 12) * 100) / 100,
    stripe_price_monthly: resolveStripePrice(product, plan.key, 'monthly'),
    stripe_price_annual: resolveStripePrice(product, plan.key, 'annual'),
  };
}

/**
 * getCatalog()         — legacy, ARION
 * getCatalog(product)  — product-aware
 */
export function getCatalog(product) {
  const p = (typeof product === 'string' && PRODUCTS.includes(product.toLowerCase()))
    ? product.toLowerCase() : DEFAULT_PRODUCT;
  return (CATALOGS[p] || []).map((plan) => {
    const annual = annualPrice(plan.monthly_usd);
    return {
      key: plan.key,
      product: p,
      name: plan.name,
      description: plan.description,
      features: plan.features,
      pricing: {
        monthly_usd: plan.monthly_usd,
        annual_usd: annual,
        annual_per_month_usd: Math.round((annual / 12) * 100) / 100,
        annual_savings_usd: Math.round((plan.monthly_usd * 12 - annual) * 100) / 100,
      },
    };
  });
}

/**
 * getStripePriceId(planKey, cycle)            — legacy, ARION
 * getStripePriceId(product, planKey, cycle)   — product-aware
 */
export function getStripePriceId(a, b, c) {
  let product, planKey, cycle;
  if (typeof a === 'string' && PRODUCTS.includes(a.toLowerCase())) {
    product = a.toLowerCase(); planKey = b; cycle = c;
  } else {
    product = DEFAULT_PRODUCT; planKey = a; cycle = b;
  }
  const plan = getPlan(product, planKey);
  if (!plan) return null;
  return cycle === 'annual' ? plan.stripe_price_annual : plan.stripe_price_monthly;
}

/** Products that have NO self-serve signup (route to /contact instead). */
export function isSelfServeProduct(product) {
  return PRODUCTS.includes(String(product || '').toLowerCase());
}

// Kept for any legacy import.
export const PLANS = ARION_PLANS;
