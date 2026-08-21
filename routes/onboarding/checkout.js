/**
 * Onboarding — Checkout Routes
 * --------------------------------------------------------------------------
 * Endpoint used by the signup page to render the plan picker:
 *
 *   GET  /catalog            — public plan catalog with live Stripe pricing
 *                              (?product=arion|stella, proxied to oliver-api)
 *
 * 2026-08-22 (Phase B1): POST /create-session DELETED — it resolved prices
 * via STRIPE_PRICE_* env vars that exist on no App Service, so it could only
 * 503; customer checkout is oliver-api /signup/checkout-cart (name-based).
 *
 * Stripe Checkout is hosted by Stripe (no card data ever hits our server).
 */

import { Router } from 'express';

const router = Router();

// ---------------------------------------------------------------------------
// GET /catalog — public, used by signup plan-picker UI
// ---------------------------------------------------------------------------
// 2026-06-20 Brandon: this endpoint was serving HARDCODED $19.99/$29.99/
// $49.99/$99.99 from lib/pricing.js ARION_PLANS, ignoring the live Stripe
// prices Brandon manages via OLIVER → Catalog → Products & Services.
// Now proxies to oliver-api /signup/catalog?product=<product> (the single
// Stripe owner), which resolves real Stripe Prices by name + overlays
// description/features from oliver.service_offering. The response is
// re-shaped into arion-api's existing payload contract so the Portal's
// SignupPage doesn't need any changes.
//
// 2026-08-22 (Phase B3): product=stella takes the same proxy path (STELLA
// self-serve: Standard / Pro / Business, single base line, no add-ons).
const OLIVER_API_BASE = (
  process.env.OLIVER_API_BASE ||
  'https://app-oliver-api-prod-eaffhyhqgrgbcfh0.centralus-01.azurewebsites.net'
).replace(/\/$/, '');

// Products this proxy serves. OLIVER / SPARK catalogs are served by
// oliver-api /signup/catalog directly (410 below).
export const PROXIED_CATALOG_PRODUCTS = ['arion', 'stella'];

// 2026-06-20 update: oliver-api/lib/signupPricing.js now returns a
// `pricing: { monthly_usd, annual_usd, annual_per_month_usd,
//             annual_savings_pct }`
// envelope on every plan. This proxy just passes it through. The old
// `annualFromMonthly` derivation is kept ONLY as a defensive fallback in
// case the upstream is stale (deploy lag) and only returns the legacy
// flat monthly_usd field.
export function pricingPassthroughOrDerive(p) {
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
  // ?product=arion|stella (default arion — backward compatible)
  const product = String(req.query?.product || 'arion').toLowerCase();
  const cycle = req.query?.billing === 'annual' ? 'annual' : 'monthly';
  try {
    if (product === 'oliver' || product === 'spark') {
      // SUPERSEDED — OLIVER/SPARK catalog is served by oliver-api /signup/catalog.
      return res.status(410).json({
        error: { code: 'MOVED', status: 410, message: 'Use oliver-api /signup/catalog for OLIVER/SPARK.' },
      });
    }
    if (!PROXIED_CATALOG_PRODUCTS.includes(product)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', status: 400, message: `unknown product "${product}"` } });
    }

    // Proxy to oliver-api. If it fails (network, 5xx, missing prices), we
    // surface a 503 — the customer needs to see live prices or a clear
    // 'unavailable' message, NOT stale hardcoded numbers that would let
    // them check out at the wrong price.
    const upstream = `${OLIVER_API_BASE}/signup/catalog?product=${encodeURIComponent(product)}&billing=${cycle}`;
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
      product,
      name: p.name,
      description: p.description,
      features: p.features,
      pricing: pricingPassthroughOrDerive(p),
    }));

    // Pass through ARION SEO add-ons if oliver-api returned them (ARION only;
    // STELLA has no add-ons so the key is simply absent).
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

export default router;
