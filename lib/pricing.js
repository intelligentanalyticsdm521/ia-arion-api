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

import { getStripeClient } from './stripe.js';

export const ANNUAL_DISCOUNT = 0.10;

export const PRODUCTS = ['arion', 'oliver', 'spark'];
const DEFAULT_PRODUCT = 'arion';

// ── ARION (base tiers = website / hosting / analytics / GBP) ───────────────
// Plan keys MUST match the Stripe product names so oliver-api's
// /signup/checkout-cart `buildArionLineItems` regex (matches "arion <plan>")
// resolves correctly. Prices + copy re-set by Brandon 2026-08-21
// (overnight-report/PRICING_REWORK_DECISIONS_2026-08-21.md §ARION).
//
// SEO is an ADD-ON ladder (starter/essentials/growth/authority) sold
// separately on the SignupPage SEO selector — NO keyword / ranking / audit /
// AI-search / Market Monitor copy belongs in a base plan. Site limits are
// keyed to these base tiers (routes/arion/sites.js TIER_SITE_LIMITS).
// Form → SPARK / Form → OLIVER flows are platform rules (owning both
// products), not tier bullets. IA Insights Health/Trends/Reports scale with
// the data each tier connects; Intelligence is Pro+ on every platform.
const ARION_PLANS = [
  { key: 'lite',     name: 'Lite',     description: 'AI-built website on managed hosting',
    monthly_usd: 19.99,  features: ['AI website builder', 'Managed hosting (domain, DNS, SSL, backups, security monitoring)', 'IA Plugin', 'Forms', 'Basic Core Web Vitals', 'IA Insights website reports'] },
  { key: 'standard', name: 'Standard', description: 'Website + Google and Bing integrations + My Brand studio',
    monthly_usd: 34.99,  features: ['Everything in Lite', 'Google Analytics 4', 'Search Console', 'Bing Webmaster + IndexNow', 'Hosting performance + vulnerability scans', 'My Brand studio'] },
  { key: 'pro',      name: 'Pro',      description: 'Local presence suite + staging + IA Insights Intelligence',
    monthly_usd: 69.99,  features: ['Everything in Standard', 'Google Business Profile suite (locations, reviews, posts, services, performance)', 'Bing Places + Apple Business Connect', 'Staging', 'My Brand Pro', 'IA Insights Intelligence'] },
  { key: 'business', name: 'Business', description: 'Pro for up to 3 sites, with full analytics + insight reports',
    monthly_usd: 129.99, features: ['Everything in Pro', '3 sites included (+$29.99/mo per additional site)', 'Full Analytics + Insight Reports', 'My Brand Business'] },
];

// ── OLIVER (canonical base ladder — Enterprise is contact-sales, not here) ──
//
// Brandon 2026-08-21 (PRICING_REWORK_DECISIONS §OLIVER): Lite is sold as
// "OLIVER Invoicing" (plan key stays `lite`) with ZERO jobs; Standard / Pro /
// Business re-priced. Copy names only what is built — GPS / crew tracking,
// route optimization, offline mobile, QuickBooks / Xero sync and consumer
// financing are NOT built and must not appear. Books + unit economics come
// from STELLA. Stripe is the runtime source of truth for the amount charged —
// this list seeds the catalog fallback + the description/features only.
const OLIVER_PLANS = [
  { key: 'lite',     name: 'Invoicing', description: 'Quote, propose and invoice — one seat, no jobs. Add Standard when you need scheduling.',
    monthly_usd: 19.99,  features: ['1 seat', 'Quotes + pricebook', 'Proposals', 'Invoices + Stripe payment links', 'Deposits + partial payments', 'Basic 30-day reporting', 'No jobs, portal, or automations'] },
  { key: 'standard', name: 'Standard', description: 'Jobs + customer portal for a small team. You approve everything.',
    monthly_usd: 79.99,  features: ['5 seats ($15/extra seat)', 'Unlimited jobs — board + kanban', 'Customer portal (messaging + reschedule requests you approve)', 'Team management, manual assignment + offer queue', 'Recurring jobs (approval queue)', 'Booking pages (manual confirm)', 'Signatures on quotes + invoices'] },
  { key: 'pro',      name: 'Pro',      description: 'Automation kicks in. Auto-schedule, auto-assign, crew app, field completion verification.',
    monthly_usd: 179.99, features: ['10 seats ($12/extra seat)', 'Automations engine (20+ event-driven rules)', 'Auto-scheduled recurring (100)', 'Crew app (employee mobile)', 'Field completion verification (photos / signatures / ratings / checklists)', 'Booking pages (instant confirm + .ics + M365 calendar sync)', 'Instant customer self-reschedule', 'Time + expense tracking'] },
  { key: 'business', name: 'Business', description: 'Multi-location operations. Job costing, custom automations, payouts, books via STELLA.',
    monthly_usd: 349.99, features: ['25 seats ($10/extra seat)', 'Multi-location / multi-entity controls', 'Custom automation rules (build your own)', 'Job costing + profit reporting', 'Stripe Connect contractor payouts', 'Books + unit economics via STELLA', 'Roles, permissions, approvals + audit logs'] },
];

// ── SPARK (Phase-1 self-serve: base 5k-email tier + feature add-on) ─────────
// Brandon 2026-08-21: Standard = 5k base ($19.99). Pro = base + Pro add-on
// ($19.99 + $49.99 = $69.98). Business = base + Business add-on
// ($19.99 + $99.99 = $119.98). monthly_usd is the bundle TOTAL for display;
// checkout charges two Stripe lines (volume + feature add-on) resolved by
// product name in buildSignupLineItems — nothing derives the add-on amount
// from these totals. Volume is adjustable in Settings post-signup (do not put
// the full volume slider in signup). Form → CRM auto-flow is a platform rule
// (any tenant owning ARION + SPARK); the hosted form builder is what every
// Standard tenant gets regardless.
const SPARK_PLANS = [
  { key: 'standard', name: 'Standard', description: 'CRM + email — 5,000 emails/mo to start',
    monthly_usd: 19.99,  features: ['Full CRM — contacts, companies, lists + tags', 'Email campaigns, templates + A/B tests', 'Forms + form builder (hosted page, iframe embed, QR)', 'Website forms flow into your CRM with an automatic reply', '5k emails / 1k contacts (adjustable)'] },
  { key: 'pro',      name: 'Pro',      description: 'Marketing power tools',
    monthly_usd: 69.98,  features: ['Everything in Standard', 'SMS campaigns + inbox', 'Segments + prebuilt automations', 'Sales pipeline, deals + tasks', 'Newsletter Studio + landing pages', 'AI suggestions + Intelligence reports'] },
  { key: 'business', name: 'Business', description: 'Journeys, attribution + account-level CRM',
    monthly_usd: 119.98, features: ['Everything in Pro', 'Customer journeys', 'Revenue attribution', 'NPS + referrals', 'Approvals + anomaly alerts', 'Audience sync, lead scoring + contact 360'] },
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

/* ===========================================================================
 * STRIPE-RESOLVED PRICING (OLIVER / SPARK self-serve signup)
 * ---------------------------------------------------------------------------
 * Stripe is the source of truth. Prices are resolved by the exact product
 * NAME convention created in the OLIVER catalog, cached. ARION keeps its
 * existing env-var path above (live — untouched).
 *
 * Interval guard: a price only fills the 'monthly' slot if recurring.interval
 * === 'month' and the 'annual' slot only if === 'year'. A mis-created annual
 * price (interval=month with the yearly amount) therefore CANNOT be charged
 * as annual — that cycle is simply unavailable until the price is fixed.
 * =========================================================================*/

// Exact Stripe product names (must match the catalog-created products).
// OLIVER Lite is sold as "OLIVER Invoicing" from 2026-08-21 (plan key stays
// `lite`). The Stripe product rename is a Brandon step, so accept the new
// name first and the old one second — checkout keeps resolving on either
// side of the rename.
const OLIVER_PRODUCT_NAME = {
  lite: ['OLIVER - Invoicing', 'OLIVER – Invoicing', 'OLIVER - Lite'],
  standard: 'OLIVER - Standard',
  pro: 'OLIVER - Pro', business: 'OLIVER - Business',
};
export const SPARK_VOLUMES = ['5k','10k','15k','25k','50k','100k','150k','250k','500k'];
const sparkVolumeName = (v) => `SPARK - Standard ${v}`;
const SPARK_FEATURE_ADDON_NAME = { pro: 'SPARK - Pro', business: 'SPARK - Business' };
const SPARK_LEADS_PKG_NAME = {
  essentials: 'SPARK Leads - Essentials 50',
  growth:     'SPARK Leads - Growth',
  authority:  'SPARK Leads - Authority',
};
const SPARK_LEADS_ADDON_NAME = {
  essentials: 'SPARK Leads - Essentials - Leads Add Ons',
  growth:     'SPARK Leads - Growth - Leads Add-On',
  authority:  'SPARK Leads - Authority - Leads Add-on',
};
// Leads each package INCLUDES, and the per-unit increment of the add-on.
export const SPARK_LEADS_INCLUDED   = { essentials: 50,  growth: 100, authority: 150 };
export const SPARK_LEADS_INCREMENT  = { essentials: 5,   growth: 10,  authority: 10  };

let _priceIndex = null;        // { [productName]: { month:{id,amount}, year:{id,amount} } }
let _priceIndexAt = 0;
const PRICE_TTL_MS = 5 * 60 * 1000;

async function priceIndex() {
  if (_priceIndex && (Date.now() - _priceIndexAt) < PRICE_TTL_MS) return _priceIndex;
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe not configured');
  const idx = {};
  let starting_after;
  do {
    const pg = await stripe.prices.list({
      limit: 100, active: true, ...(starting_after ? { starting_after } : {}),
      expand: ['data.product'],
    });
    for (const p of pg.data) {
      if (!p.recurring) continue;
      const name = (p.product && p.product.name) || '';
      if (!name) continue;
      const slot = p.recurring.interval === 'year' ? 'year'
                 : p.recurring.interval === 'month' ? 'month' : null;
      if (!slot) continue;
      idx[name] = idx[name] || {};
      // First write wins per slot; ignore duplicates.
      if (!idx[name][slot]) idx[name][slot] = { id: p.id, amount: p.unit_amount / 100 };
    }
    starting_after = pg.has_more ? pg.data[pg.data.length - 1].id : null;
  } while (starting_after);
  _priceIndex = idx; _priceIndexAt = Date.now();
  return idx;
}

const slotFor = (cycle) => (cycle === 'annual' ? 'year' : 'month');

async function priceByName(productName, cycle) {
  const idx = await priceIndex();
  // A single name, or an ordered list of candidate names (first hit wins).
  for (const name of [].concat(productName)) {
    const entry = idx[name];
    if (entry && entry[slotFor(cycle)]) return entry[slotFor(cycle)];
  }
  return null; // null if no candidate has that interval (guard)
}

/** Live signup catalog for the picker (real Stripe amounts). */
export async function getStripeCatalog(product, cycle = 'monthly') {
  const p = String(product || '').toLowerCase();
  if (p === 'oliver') {
    const out = [];
    for (const [key, pl] of Object.entries(OLIVER_PLANS_BYKEY)) {
      const pr = await priceByName(OLIVER_PRODUCT_NAME[key], cycle)
              || await priceByName(OLIVER_PRODUCT_NAME[key], 'monthly');
      if (!pr) continue;
      out.push({ key, product: 'oliver', name: pl.name, description: pl.description,
        features: pl.features, pricing: { monthly_usd: pr.amount, annual_usd: null, annual_per_month_usd: null, annual_savings_usd: null } });
    }
    return out;
  }
  if (p === 'spark') {
    const volumes = [];
    for (const v of SPARK_VOLUMES) {
      const pr = await priceByName(sparkVolumeName(v), cycle) || await priceByName(sparkVolumeName(v), 'monthly');
      if (pr) volumes.push({ key: `standard_${v}`, volume: v, name: `Standard ${v}`, pricing: { monthly_usd: pr.amount } });
    }
    const addons = {};
    for (const k of Object.keys(SPARK_FEATURE_ADDON_NAME)) {
      const pr = await priceByName(SPARK_FEATURE_ADDON_NAME[k], cycle) || await priceByName(SPARK_FEATURE_ADDON_NAME[k], 'monthly');
      if (pr) addons[k] = { name: `SPARK ${k[0].toUpperCase()}${k.slice(1)}`, monthly_usd: pr.amount };
    }
    const leads = {};
    for (const k of Object.keys(SPARK_LEADS_PKG_NAME)) {
      const pr = await priceByName(SPARK_LEADS_PKG_NAME[k], cycle) || await priceByName(SPARK_LEADS_PKG_NAME[k], 'monthly');
      const ad = await priceByName(SPARK_LEADS_ADDON_NAME[k], cycle) || await priceByName(SPARK_LEADS_ADDON_NAME[k], 'monthly');
      if (pr) leads[k] = {
        name: `Leads ${k[0].toUpperCase()}${k.slice(1)}`, monthly_usd: pr.amount,
        included: SPARK_LEADS_INCLUDED[k], increment: SPARK_LEADS_INCREMENT[k],
        addon_unit_usd: ad ? ad.amount : null,
      };
    }
    return { product: 'spark', volumes, featureAddons: addons, leads };
  }
  return [];
}

const OLIVER_PLANS_BYKEY = Object.fromEntries(OLIVER_PLANS.map((p) => [p.key, p]));

/**
 * Build Stripe Checkout line_items for an OLIVER/SPARK signup.
 *  sel = { plan?, volume?, featureAddon?, leads?, leadsSelected? }
 *   - OLIVER: { plan }                              → 1 line
 *   - SPARK : { volume, featureAddon?, leads?, leadsSelected? }
 *             volume (5k…) base + optional Pro/Business + optional Leads
 *             package + leads add-on qty = ceil((selected-included)/incr)
 * Returns { line_items, resolved } or throws a 503-ish Error if a required
 * price is missing for the requested cycle.
 */
export async function buildSignupLineItems(product, sel, cycle) {
  const p = String(product || '').toLowerCase();
  const need = async (name, label) => {
    const pr = await priceByName(name, cycle);
    if (!pr) {
      const e = new Error(`No ${cycle} Stripe price for "${[].concat(name).join('" / "')}" (${label})`);
      e.code = 'PRICE_UNAVAILABLE';
      throw e;
    }
    return pr;
  };

  if (p === 'oliver') {
    const key = String(sel?.plan || '').toLowerCase();
    if (!OLIVER_PRODUCT_NAME[key]) { const e = new Error('invalid OLIVER plan'); e.code = 'BAD_PLAN'; throw e; }
    const pr = await need(OLIVER_PRODUCT_NAME[key], 'OLIVER base');
    return { line_items: [{ price: pr.id, quantity: 1 }], resolved: { base: pr.id } };
  }

  if (p === 'spark') {
    const volume = String(sel?.volume || '5k').toLowerCase();
    if (!SPARK_VOLUMES.includes(volume)) { const e = new Error('invalid SPARK volume'); e.code = 'BAD_PLAN'; throw e; }
    const items = [];
    const resolved = {};
    const base = await need(sparkVolumeName(volume), 'SPARK volume');
    items.push({ price: base.id, quantity: 1 }); resolved.base = base.id;

    const fa = sel?.featureAddon ? String(sel.featureAddon).toLowerCase() : null;
    if (fa && SPARK_FEATURE_ADDON_NAME[fa]) {
      const a = await need(SPARK_FEATURE_ADDON_NAME[fa], 'SPARK feature add-on');
      items.push({ price: a.id, quantity: 1 }); resolved.featureAddon = a.id;
    }

    const lk = sel?.leads ? String(sel.leads).toLowerCase() : null;
    if (lk && SPARK_LEADS_PKG_NAME[lk]) {
      const pkg = await need(SPARK_LEADS_PKG_NAME[lk], 'SPARK leads package');
      items.push({ price: pkg.id, quantity: 1 }); resolved.leadsPkg = pkg.id;

      const included = SPARK_LEADS_INCLUDED[lk];
      const incr = SPARK_LEADS_INCREMENT[lk];
      const selected = Math.max(included, Number(sel?.leadsSelected) || included);
      const qty = Math.ceil(Math.max(0, selected - included) / incr);
      if (qty > 0) {
        const ad = await need(SPARK_LEADS_ADDON_NAME[lk], 'SPARK leads add-on');
        items.push({ price: ad.id, quantity: qty }); resolved.leadsAddon = { id: ad.id, qty };
      }
    }
    return { line_items: items, resolved };
  }

  const e = new Error('buildSignupLineItems supports oliver|spark only');
  e.code = 'BAD_PRODUCT';
  throw e;
}

