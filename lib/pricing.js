/**
 * Pricing — IADM multi-product plan catalog and price math.
 * --------------------------------------------------------------------------
 * Source of truth for SELF-SERVE signup plan COPY and the fallback amounts.
 * Annual = monthly × 12 × 0.90 (10% off), rounded half-up to the cent.
 *
 * Stripe price IDs are NEVER hardcoded and NEVER read from env vars. Live
 * prices are resolved by PRODUCT NAME among ACTIVE recurring Stripe Prices
 * (see "STRIPE-RESOLVED PRICING" below) — exactly how oliver-api
 * lib/signupPricing.js does it, so both APIs sell the same price.
 *
 * 2026-08-22 (Phase B1): the STRIPE_PRICE_<PRODUCT>_<PLAN>_<CYCLE> env-var
 * resolver (resolveStripePrice / getStripePriceId / getPlan().stripe_price_*)
 * was DELETED together with routes/onboarding/checkout.js POST
 * /create-session — no such env var exists on any App Service, so the path
 * could only 503. Customer checkout is oliver-api /signup/checkout-cart.
 *
 * Product-aware (added 2026-05-18 for unified signup). BACKWARD COMPATIBLE:
 * every legacy single-arg ARION call still works unchanged.
 */

import { getStripeClient } from './stripe.js';

export const ANNUAL_DISCOUNT = 0.10;

export const PRODUCTS = ['arion', 'oliver', 'spark', 'stella'];
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

// ── STELLA (bookkeeping + unit economics — Phase B3, 2026-08-22) ────────────
// Brandon 2026-08-21 (PRICING_REWORK_DECISIONS §STELLA): Standard $49.99 /
// Pro $99.99 / Business $199.99, annual ×12×0.9. No Lite. Copy from the
// packages guide §4 + FEATURE_TIER_MATRIX_FULL §9.
//
// AT LAUNCH EVERY STELLA TIER GETS EVERYTHING LIVE TODAY (ledger, Plaid bank
// feeds, paid OLIVER invoices → ledger, unit economics, monthly close,
// reporting) — requireStellaAccess gates ownership only; there is no tier
// check inside STELLA yet. The Pro / Business bullets are the blueprint §13
// splits (SQL editor / Custom Reporting → Pro; multi-entity + Database
// Manager → Business) and MUST say "(rolling out)" until those gates exist.
// Stripe product names: 'STELLA - <Tier>' (STELLA_PRODUCT_NAME below).
const STELLA_PLANS = [
  { key: 'standard', name: 'Standard', description: 'Books that live next to your jobs — ledger, bank feeds, invoices in, per-job margins out.',
    monthly_usd: 49.99,  features: ['Ledger — overview, inbox, transactions, vendors + customers (W-9 / 1099), chart of accounts', 'Plaid bank + card feeds', 'Paid OLIVER invoices flow into the ledger automatically', 'Unit economics — per-job + per-customer margins', 'Monthly close + period lock', 'Reports — P&L, Cash Flow, AR Aging, Sales Tax, 1099 candidates', 'IA Insights reports'] },
  { key: 'pro',      name: 'Pro',      description: 'Standard plus custom reporting and deeper reconciliation. Pro features rolling out.',
    monthly_usd: 99.99,  features: ['Everything in Standard', 'More bank connections + auto-categorization (rolling out)', 'Full reconciliation + weighted allocation methods (rolling out)', 'Custom Reporting — report builder, dashboards, scheduled reports, exports (rolling out)', 'SQL editor (rolling out)'] },
  { key: 'business', name: 'Business', description: 'Pro plus multi-entity books and the Database Manager. Business features rolling out.',
    monthly_usd: 199.99, features: ['Everything in Pro', 'Multi-entity books (rolling out)', 'Database Manager — views, uploads, custom fields, documents, compliance reminders (rolling out)', 'Bookkeeper role + period-close lockdown (rolling out)', 'Daily refresh + webhooks (rolling out)'] },
];

const CATALOGS = { arion: ARION_PLANS, oliver: OLIVER_PLANS, spark: SPARK_PLANS, stella: STELLA_PLANS };

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

/**
 * getPlan(key)                 — legacy, ARION
 * getPlan(product, key)        — product-aware
 * Copy + fallback amounts only — no Stripe price IDs (see header).
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

/** Products that have NO self-serve signup (route to /contact instead). */
export function isSelfServeProduct(product) {
  return PRODUCTS.includes(String(product || '').toLowerCase());
}

// Kept for any legacy import.
export const PLANS = ARION_PLANS;

/* ===========================================================================
 * STRIPE-RESOLVED PRICING (OLIVER / SPARK / STELLA self-serve signup)
 * ---------------------------------------------------------------------------
 * Stripe is the source of truth. Prices are resolved by the exact product
 * NAME convention created in the OLIVER catalog, cached, paged over every
 * ACTIVE recurring price. ARION's live catalog comes from oliver-api
 * /signup/catalog (routes/onboarding/checkout.js GET /catalog proxies it).
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
// STELLA — Stripe products verified 2026-08-22: "STELLA - Standard"
// $49.99/$539.89, "STELLA - Pro" $99.99/$1,079.89 (annual interval=year
// fixed in the cutover), "STELLA - Business" $199.99/$2,159.89.
export const STELLA_PRODUCT_NAME = {
  standard: 'STELLA - Standard',
  pro: 'STELLA - Pro',
  business: 'STELLA - Business',
};
export const SPARK_VOLUMES = ['5k','10k','15k','25k','50k','100k','150k','250k','350k','500k']; // 350k: Stripe product created 2026-08-22 (Brandon)
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

/**
 * Seed the price index without a Stripe call. Tests use it to exercise the
 * name → price resolution with a fake index (no live Stripe); passing null
 * clears the cache so the next call re-lists.
 */
export function primePriceIndex(idx) {
  _priceIndex = idx || null;
  _priceIndexAt = idx ? Date.now() : 0;
}

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

// One base-plan-per-line catalog (OLIVER, STELLA): the live Stripe amount for
// the requested cycle (monthly as the fallback) with the plan copy from here.
async function basePlanCatalog(product, plansByKey, productNames, cycle) {
  const out = [];
  for (const [key, pl] of Object.entries(plansByKey)) {
    const pr = await priceByName(productNames[key], cycle)
            || await priceByName(productNames[key], 'monthly');
    if (!pr) continue;
    out.push({ key, product, name: pl.name, description: pl.description,
      features: pl.features, pricing: { monthly_usd: pr.amount, annual_usd: null, annual_per_month_usd: null, annual_savings_usd: null } });
  }
  return out;
}

/** Live signup catalog for the picker (real Stripe amounts). */
export async function getStripeCatalog(product, cycle = 'monthly') {
  const p = String(product || '').toLowerCase();
  if (p === 'oliver') return basePlanCatalog('oliver', OLIVER_PLANS_BYKEY, OLIVER_PRODUCT_NAME, cycle);
  if (p === 'stella') return basePlanCatalog('stella', STELLA_PLANS_BYKEY, STELLA_PRODUCT_NAME, cycle);
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
const STELLA_PLANS_BYKEY = Object.fromEntries(STELLA_PLANS.map((p) => [p.key, p]));

/**
 * Build Stripe Checkout line_items for an OLIVER/SPARK/STELLA signup.
 *  sel = { plan?, volume?, featureAddon?, leads?, leadsSelected? }
 *   - OLIVER: { plan }                              → 1 line
 *   - STELLA: { plan }                              → 1 line (no add-ons)
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

  if (p === 'oliver' || p === 'stella') {
    const names = p === 'oliver' ? OLIVER_PRODUCT_NAME : STELLA_PRODUCT_NAME;
    const key = String(sel?.plan || '').toLowerCase();
    if (!names[key]) { const e = new Error(`invalid ${p.toUpperCase()} plan`); e.code = 'BAD_PLAN'; throw e; }
    const pr = await need(names[key], `${p.toUpperCase()} base`);
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

  const e = new Error('buildSignupLineItems supports oliver|spark|stella only');
  e.code = 'BAD_PRODUCT';
  throw e;
}
