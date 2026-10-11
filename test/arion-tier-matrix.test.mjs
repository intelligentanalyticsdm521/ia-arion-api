/**
 * ARION features follow the ARION TIER in the subscription (Brandon, 11 Oct
 * 2026: "ARION pro has different features than ARION lite").
 *
 * Runs the real middleware/requireArionTier.js gate over the real ARION route
 * paths, with platform-api and the database stubbed, and checks every rung of
 * FEATURE_TIER_MATRIX_FULL.md §1 (with §6 for IA Insights and §7/§13 for SEO):
 *   below the feature's tier -> 402 TIER_LIMIT_REACHED naming the tier
 *   at or above it           -> through, as before
 *   a null tier on an owned ARION, and no site row -> through (allow + log)
 *   undecided                -> the site row is the fallback
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireArionTier, minTierFor } from '../middleware/requireArionTier.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const S = '/arion/sites/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const ent = (tier, { decided = true, owned = true, source = 'stripe' } = {}) => async () => ({
  tenant_id: TENANT, decided,
  products: { arion: { owned, tier, tier_source: source, decided } },
});
const sitePool = (arion_tier = null) => async () => ({
  request() {
    const rq = { input() { return rq; }, async query() { return { recordset: arion_tier ? [{ arion_tier, plan: null }] : [] }; } };
    return rq;
  },
});

async function gate(path, deps) {
  const req = { originalUrl: path, tenant: { tenantId: TENANT } };
  let status = 200;
  let body = null;
  let passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await requireArionTier(deps)(req, res, () => { passed = true; });
  return { passed, status, body };
}

// [path, minimum tier] — null = every tier. Paths are the real ARION routes.
const MATRIX = [
  // every tier
  ['/arion/overview', null],
  ['/arion/hosting', null],
  ['/arion/hosting/dns', null],
  [`${S}/plugin/security`, null],
  [`${S}/plugin/security/wordfence-full`, null],
  [`${S}/plugin/security/scan-issues`, null],
  ['/arion/search/core-web-vitals', null],
  [`${S}/pagespeed-history`, null],
  ['/arion/insights/metrics?siteId=x', null],
  ['/arion/ia-insights/scores', null],
  ['/arion/analytics/report?siteId=x&type=monthly_summary', null],
  ['/arion/analytics/insights?siteId=x', null],
  [`${S}/pages`, null],
  ['/arion/seo/overview', null], // SEO is the add-on ladder, never the base tier
  // Standard
  ['/arion/analytics?siteId=x', 'standard'],
  ['/arion/website-analytics/GOOGLE?siteId=x', 'standard'],
  [`${S}/plugin/ga4/set`, 'standard'],
  ['/arion/console/google?siteId=x', 'standard'],
  [`${S}/gsc`, 'standard'],
  ['/arion/search/performance', 'standard'],
  ['/arion/search/url-inspection', 'standard'],
  ['/arion/search/submit-url', 'standard'],
  ['/arion/search/sitemaps', 'standard'],
  ['/arion/search/generate-sitemap', 'standard'],
  ['/arion/search/indexnow', 'standard'],
  ['/arion/search/bing/stats', 'standard'],
  ['/arion/bing/status', 'standard'],
  [`${S}/vulnerabilities`, 'standard'],
  [`${S}/plugin/security/wordfence-config`, 'standard'],
  // Pro
  ['/arion/staging', 'pro'],
  [`${S}/gbp/locations`, 'pro'],
  ['/arion/business/reviews', 'pro'],
  ['/arion/business/posts', 'pro'],
  ['/arion/my-business/google?siteId=x', 'pro'],
  ['/arion/my-business/apple?siteId=x', 'pro'],
  ['/arion/business-locations', 'pro'],
  [`/arion/sites/x/apple/mark-claimed`, 'pro'],
  ['/arion/review-replies/run', 'pro'],
  [`${S}/intelligence`, 'pro'],
  ['/intelligence/arion/platform-pulse/x', 'pro'],
];

const RUNGS = ['lite', 'standard', 'pro', 'business'];
const rank = (t) => RUNGS.indexOf(t);

test('every path maps to the tier the matrix gives it', () => {
  for (const [path, min] of MATRIX) {
    const rule = minTierFor(path);
    assert.equal(rule ? rule.tier : null, min, `${path} should need ${min || 'every tier'}`);
  }
});

test('each rung reaches exactly the features at or below it, from the subscription tier', async () => {
  for (const tier of RUNGS) {
    for (const [path, min] of MATRIX) {
      // The site row says business; the subscription must win over it.
      const r = await gate(path, { getEntitlements: ent(tier), getServicesPool: sitePool('business') });
      const allowed = !min || rank(tier) >= rank(min);
      assert.equal(r.passed, allowed, `${tier} on ${path} (needs ${min || 'every tier'})`);
      if (!allowed) {
        assert.equal(r.status, 402);
        assert.equal(r.body.error.code, 'TIER_LIMIT_REACHED');
        assert.match(r.body.error.message, new RegExp(`requires ARION ${min[0].toUpperCase()}${min.slice(1)}`));
        assert.deepEqual(r.body.error.upgrade, { current_tier: tier, required_tier: min });
      }
    }
  }
});

test('ARION Lite is refused Pro features even when the site row is stamped higher (any tier source)', async () => {
  for (const source of ['stripe', 'core.tenant_services', 'comped']) {
    const r = await gate(`${S}/gbp/locations`, { getEntitlements: ent('lite', { source }), getServicesPool: sitePool('pro') });
    assert.equal(r.passed, false, source);
    assert.equal(r.status, 402);
  }
});

test('a null tier on an owned ARION, with no site row, is allowed (never deny on an unknown tier)', async () => {
  const r = await gate(`${S}/gbp/locations`, { getEntitlements: ent(null, { source: 'none' }), getServicesPool: sitePool(null) });
  assert.equal(r.passed, true);
});

test('a null tier on an owned ARION falls back to the site row', async () => {
  const low = await gate(`${S}/gbp/locations`, { getEntitlements: ent(null, { source: 'none' }), getServicesPool: sitePool('lite') });
  assert.equal(low.passed, false);
  const high = await gate(`${S}/gbp/locations`, { getEntitlements: ent(null, { source: 'none' }), getServicesPool: sitePool('pro') });
  assert.equal(high.passed, true);
});

test('undecided: the site row answers; platform-api down never locks anybody out by itself', async () => {
  const r1 = await gate(`${S}/gbp/locations`, { getEntitlements: ent('lite', { decided: false }), getServicesPool: sitePool('pro') });
  assert.equal(r1.passed, true, 'undecided lite never demotes the site row');
  const r2 = await gate(`${S}/gbp/locations`, { getEntitlements: async () => null, getServicesPool: sitePool(null) });
  assert.equal(r2.passed, true, 'nothing known -> allowed');
});
