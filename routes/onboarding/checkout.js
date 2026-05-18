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
    void getStripeCatalog; // retained import; ARION path below unchanged
    res.json({
      data: { product, plans: getCatalog(product) }, // ARION (env, unchanged)
      meta: { timestamp: new Date().toISOString() },
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
        success_url: `${PORTAL_URL}/signup/onboarding?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${PORTAL_URL}/signup?cancelled=1`,
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
