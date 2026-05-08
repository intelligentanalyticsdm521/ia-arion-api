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
import { getCatalog, getStripePriceId, getPlan } from '../../lib/pricing.js';
import { getStripeClient, ensureCustomer, idempotencyKey } from '../../lib/stripe.js';

const router = Router();

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.intelligentanalyticsdm.com';
const FREE_FIRST_YEAR_COUPON_ID = process.env.STRIPE_DOMAIN_FREE_FIRST_YEAR_COUPON || '';

// ---------------------------------------------------------------------------
// GET /catalog — public, used by signup plan-picker UI
// ---------------------------------------------------------------------------
router.get('/catalog', (_req, res) => {
  res.json({
    data: { plans: getCatalog() },
    meta: { timestamp: new Date().toISOString() },
  });
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

  // Validation
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'email required', status: 400 } });
  }
  const planMeta = getPlan(plan);
  if (!planMeta) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid plan', status: 400 } });
  }
  if (!['monthly', 'annual'].includes(billing_cycle)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'billing_cycle must be monthly|annual', status: 400 } });
  }
  if (!domain || !domain.mode || !['purchase', 'byod'].includes(domain.mode)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain.mode must be purchase|byod', status: 400 } });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Stripe not configured', status: 503 } });
  }

  const priceId = getStripePriceId(plan, billing_cycle);
  if (!priceId) {
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: `Stripe price not configured for ${plan}/${billing_cycle}`, status: 503 } });
  }

  try {
    // 1. Customer (find-or-create by email)
    const customer = await ensureCustomer({
      email,
      name,
      metadata: { source: 'arion_signup', plan, billing_cycle },
    });

    // 2. Build line items: plan subscription + (optional) domain registration
    const lineItems = [
      { price: priceId, quantity: 1 },
    ];

    let domainLineApplied = false;
    if (domain.mode === 'purchase' && domain.name) {
      // Domain billed as a one-time payment via inline price_data so we don't
      // need a separate Stripe Product per TLD/duration.
      const domainPriceUsd = Number(domain.registration_price_usd || 14.99);
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Domain registration: ${domain.name}`,
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
      billing_cycle === 'annual' &&
      domain.mode === 'purchase' &&
      domainLineApplied &&
      FREE_FIRST_YEAR_COUPON_ID
    ) {
      discounts.push({ coupon: FREE_FIRST_YEAR_COUPON_ID });
    }

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
        subscription_data: {
          metadata: {
            plan,
            billing_cycle,
            domain_mode: domain.mode,
            domain_name: domain.name || '',
          },
        },
        metadata: {
          plan,
          billing_cycle,
          domain_mode: domain.mode,
          domain_name: domain.name || '',
        },
      },
      { idempotencyKey: idempotencyKey('checkout', email, plan, billing_cycle, domain.name || '') }
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
