/**
 * Onboarding — Checkout Routes
 * --------------------------------------------------------------------------
 * Endpoints used by the signup page after the client picks a plan. Three
 * routes:
 *
 *   GET  /catalog            — public plan catalog with pricing
 *   POST /create-session     — create a Stripe Checkout session
 *   POST /webhook            — Stripe webhook (mounted with raw body parser)
 *
 * Annual signups get the first year of their domain free via a Stripe coupon
 * applied to the domain line item (the recurring subscription is unaffected).
 *
 * Stripe Checkout is hosted by Stripe (no card data ever hits our server).
 */

import { Router } from 'express';
import { getCatalog, getStripePriceId, getPlan, getStripeCatalog, buildSignupLineItems } from '../../lib/pricing.js';
import { getStripeClient, ensureCustomer, idempotencyKey } from '../../lib/stripe.js';

const router = Router();

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.intelligentanalyticsdm.com';
const FREE_FIRST_YEAR_COUPON_ID = process.env.STRIPE_DOMAIN_FREE_FIRST_YEAR_COUPON || '';

// ---------------------------------------------------------------------------
// GET /catalog — public, used by signup plan-picker UI
// ---------------------------------------------------------------------------
// 2026-06-20 Brandon: this endpoint was serving HARDCODED $19.99/$29.99/
// $49.99/$99.99 from lib/pricing.js ARION_PLANS, ignoring the live Stripe
// prices Brandon manages via OLIVER → Catalog → Products & Services.
// Now proxies to oliver-api /signup/catalog?product=arion (the single
// Stripe owner), which resolves real Stripe Prices by name + overlays
// description/features from oliver.service_offering. The response is
// re-shaped into arion-api's existing payload contract so the Portal's
// SignupPage doesn't need any changes.
const OLIVER_API_BASE = (
  process.env.OLIVER_API_BASE ||
  'https://app-oliver-api-prod-eaffhyhqgrgbcfh0.centralus-01.azurewebsites.net'
).replace(/\/$/, '');

// 2026-06-20 update: oliver-api/lib/signupPricing.js now returns a
// `pricing: { monthly_usd, annual_usd, annual_per_month_usd,
//             annual_savings_pct }`
// envelope on every plan. This proxy just passes it through. The old
// `annualFromMonthly` derivation is kept ONLY as a defensive fallback in
// case the upstream is stale (deploy lag) and only returns the legacy
// flat monthly_usd field.
function pricingPassthroughOrDerive(p) {
  if (p && p.pricing && typeof p.pricing.monthly_usd === "number") {
    const sp = p.pricing;
    return {
      monthly_usd: sp.monthly_usd,
      annual_usd: sp.annual_usd != null ? sp.annual_usd : Math.round(sp.monthly_usd * 12 * 0.90 * 100) / 100,
      annual_per_month_usd: sp.annual_per_month_usd != null
        ? sp.annual_per_month_usd
        : Math.round(sp.monthly_usd * 12 * 0.90 / 12 * 100) / 100,
      annual_savings_usd: sp.annual_usd != null
        ? Math.round((sp.monthly_usd * 12 - sp.annual_usd) * 100) / 100
        : Math.round(sp.monthly_usd * 12 * 0.10 * 100) / 100,
    };
  }
  const m = Number(p?.monthly_usd) || 0;
  const annual = Math.round(m * 12 * 0.90 * 100) / 100;
  return {
    monthly_usd: m,
    annual_usd: annual,
    annual_per_month_usd: Math.round((annual / 12) * 100) / 100,
    annual_savings_usd: Math.round((m * 12 - annual) * 100) / 100,
  };
}

router.get('/catalog', async (req, res) => {
  // ?product=arion|oliver|spark (default arion — backward compatible)
  const product = String(req.query?.product || 'arion').toLowerCase();
  const cycle = req.query?.billing === 'annual' ? 'annual' : 'monthly';
  try {
    if (product === 'oliver' || product === 'spark') {
      // SUPERSEDED — OLIVER/SPARK catalog is served by oliver-api /signup/catalog.
      return res.status(410).json({
        error: { code: 'MOVED', status: 410, message: 'Use oliver-api /signup/catalog for OLIVER/SPARK.' },
      });
    }
    void getStripeCatalog; // retained import
    void getCatalog;       // hardcoded fallback retained for emergency only

    // Proxy to oliver-api. If it fails (network, 5xx, missing prices), we
    // surface a 503 — the customer needs to see live prices or a clear
    // 'unavailable' message, NOT stale hardcoded numbers that would let
    // them check out at the wrong price.
    const upstream = `${OLIVER_API_BASE}/signup/catalog?product=arion&billing=${cycle}`;
    const upstreamRes = await fetch(upstream, { headers: { 'Content-Type': 'application/json' } });
    if (!upstreamRes.ok) {
      const body = await upstreamRes.text().catch(() => '');
      console.error('[onboarding/catalog] proxy upstream', upstreamRes.status, body);
      return res.status(503).json({ error: { code: 'CATALOG_UPSTREAM_UNAVAILABLE', status: 503, message: `oliver-api returned ${upstreamRes.status}` } });
    }
    const upstreamBody = await upstreamRes.json();
    const upstreamPlans = upstreamBody?.data?.plans || [];

    // Re-shape into the {pricing: {monthly_usd, annual_usd, ...}} contract
    // the existing Portal SignupPage already consumes. Pass through the
    // pricing envelope from oliver-api when present, derive as fallback.
    const plans = upstreamPlans.map((p) => ({
      key: p.key,
      product: 'arion',
      name: p.name,
      description: p.description,
      features: p.features,
      pricing: pricingPassthroughOrDerive(p),
    }));

    // Pass through ARION SEO add-ons if oliver-api returned them.
    const seoAddons = upstreamBody?.data?.seoAddons || null;

    res.json({
      data: { product, plans, ...(seoAddons ? { seoAddons } : {}) },
      meta: { timestamp: new Date().toISOString(), source: 'oliver-api' },
    });
  } catch (err) {
    console.error('[onboarding/catalog]', err);
    res.status(503).json({ error: { code: 'CATALOG_UNAVAILABLE', message: err.message, status: 503 } });
  }
});

// ---------------------------------------------------------------------------
// POST /create-session
// Body: {
//   email, name?,
//   plan: "starter"|"essentials"|"growth"|"authority",
//   billing_cycle: "monthly"|"annual",
//   domain: { mode: "purchase"|"byod", name?, registration_price_usd? }
// }
// Returns: { checkout_url } — client redirects here
// ---------------------------------------------------------------------------
router.post('/create-session', async (req, res) => {
  const { email, name, plan, billing_cycle, domain } = req.body || {};
  // product is OPTIONAL and defaults to 'arion' so the existing ARION signup
  // is byte-for-byte unchanged. oliver|spark are the new self-serve products.
  const product = String(req.body?.product || 'arion').toLowerCase();
  const isArion = product === 'arion';

  // SUPERSEDED: OLIVER/SPARK self-serve runs through oliver-api (the single
  // Stripe owner). arion-api only handles its own ARION website signup.
  if (product !== 'arion') {
    return res.status(410).json({
      error: { code: 'MOVED', status: 410,
        message: 'OLIVER/SPARK signup is handled by oliver-api /signup/checkout. This endpoint is ARION-only.' },
    });
  }

  // Validation
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'email required', status: 400 } });
  }
  if (!['arion', 'oliver', 'spark'].includes(product)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid product', status: 400 } });
  }
  if (!['monthly', 'annual'].includes(billing_cycle)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'billing_cycle must be monthly|annual', status: 400 } });
  }
  // ARION validates plan via env catalog; OLIVER/SPARK validate inside the
  // Stripe-resolved line-item builder.
  if (isArion) {
    const planMeta = getPlan(product, plan);
    if (!planMeta) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid plan', status: 400 } });
    }
  }
  // Domain choice only applies to ARION (it builds a website). OLIVER/SPARK
  // have no domain step — accept a missing/placeholder domain for them.
  if (isArion && (!domain || !domain.mode || !['purchase', 'byod'].includes(domain.mode))) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain.mode must be purchase|byod', status: 400 } });
  }
  const dom = isArion ? domain : { mode: 'byod' };

  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Stripe not configured', status: 503 } });
  }

  // OLIVER/SPARK: Stripe-resolved (multi-line for SPARK). ARION: env price.
  let resolvedLines = null;
  if (!isArion) {
    try {
      const sel = product === 'spark'
        ? { volume: req.body?.volume, featureAddon: req.body?.featureAddon,
            leads: req.body?.leads, leadsSelected: req.body?.leadsSelected }
        : { plan };
      const built = await buildSignupLineItems(product, sel, billing_cycle);
      resolvedLines = built.line_items;
    } catch (e) {
      const status = e.code === 'PRICE_UNAVAILABLE' ? 503 : 400;
      return res.status(status).json({ error: { code: e.code || 'VALIDATION_ERROR', message: e.message, status } });
    }
  } else {
    const priceId = getStripePriceId(product, plan, billing_cycle);
    if (!priceId) {
      return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: `Stripe price not configured for ${product}/${plan}/${billing_cycle}`, status: 503 } });
    }
    resolvedLines = [{ price: priceId, quantity: 1 }];
  }

  try {
    // 1. Customer (find-or-create by email)
    const customer = await ensureCustomer({
      email,
      name,
      metadata: { source: `${product}_signup`, product, plan: plan || req.body?.volume || '', billing_cycle },
    });

    // 2. Line items (ARION may append a one-time domain line below)
    const lineItems = [...resolvedLines];

    let domainLineApplied = false;
    if (isArion && dom.mode === 'purchase' && dom.name) {
      // Domain billed as a one-time payment via inline price_data so we don't
      // need a separate Stripe Product per TLD/duration.
      const domainPriceUsd = Number(dom.registration_price_usd || 14.99);
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Domain registration: ${dom.name}`,
            description: '1-year domain registration via Hostinger',
          },
          unit_amount: Math.round(domainPriceUsd * 100), // cents
          tax_behavior: 'exclusive',
        },
        quantity: 1,
      });
      domainLineApplied = true;
    }

    // 3. Build discounts list — free first year on annual + purchase only
    const discounts = [];
    if (
      isArion &&
      billing_cycle === 'annual' &&
      dom.mode === 'purchase' &&
      domainLineApplied &&
      FREE_FIRST_YEAR_COUPON_ID
    ) {
      discounts.push({ coupon: FREE_FIRST_YEAR_COUPON_ID });
    }

    // Stripe metadata must be strings. Carry the full signup selection so
    // the webhook can record it without DB lookups.
    const signupMeta = {
      product,
      plan: String(plan || ''),
      billing_cycle,
      domain_mode: dom.mode || '',
      domain_name: dom.name || '',
      volume: String(req.body?.volume || ''),
      feature_addon: String(req.body?.featureAddon || ''),
      leads: String(req.body?.leads || ''),
      leads_selected: String(req.body?.leadsSelected || ''),
    };

    // 4. Create the Checkout session
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customer.id,
        line_items: lineItems,
        ...(discounts.length ? { discounts } : { allow_promotion_codes: true }),
        // Portal routes renamed /signup → /pricing on 2026-05-20. Old
        // /signup paths still 301 client-side, so sessions created
        // before this change still resolve.
        success_url: `${PORTAL_URL}/pricing/onboarding?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${PORTAL_URL}/pricing?cancelled=1`,
        billing_address_collection: 'required',
        // Carry signup intent into the subscription metadata so the webhook
        // handler can reconstruct the onboarding context without DB lookups.
        subscription_data: { metadata: signupMeta },
        metadata: signupMeta,
      },
      { idempotencyKey: idempotencyKey('checkout', product, email, plan || req.body?.volume || '', billing_cycle, dom.name || '') }
    );

    return res.json({
      data: { checkout_url: session.url, session_id: session.id },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/checkout]', err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: { code: status === 500 ? 'INTERNAL_ERROR' : 'STRIPE_ERROR', message: err.message, status },
    });
  }
});

export default router;
