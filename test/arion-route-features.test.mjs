/**
 * Every tiered ARION route names a catalog feature key (11 Oct 2026; replaces
 * test/arion-tier-matrix.test.mjs and middleware/requireArionTier.js
 * PATH_MIN_TIER).
 *
 * Runs the REAL mounted gate (middleware/arionRouteFeatures.js) over the real
 * ARION route paths with platform-api stubbed: the path's key decides, and
 * whatever tier the key needs lives only in the catalog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arionRouteFeatures, featureForPath, ROUTE_FEATURES } from '../middleware/arionRouteFeatures.js';
import { entry, planSaying, fixtureKeys } from './helpers/feature-fakes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT = '11111111-2222-3333-4444-555555555555';
const S = '/arion/sites/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// [path, feature key] — null = no feature (every ARION owner). Real routes.
const MAP = [
  ['/arion/overview', null],
  ['/arion/hosting', null],
  [`${S}/plugin/security`, null],
  [`${S}/plugin/security/wordfence-full`, null],
  [`${S}/plugin/security/scan-issues`, null],
  ['/arion/search/core-web-vitals', null],
  [`${S}/pagespeed-history`, null],
  ['/arion/insights/metrics?siteId=x', null],
  ['/arion/ia-insights/scores', null],
  [`${S}/pages`, null],
  ['/arion/seo/overview', null], // SEO is requireSeoAddon's (the add-on, per site)
  ['/arion/hosting/dns?siteId=x', 'arion_hosting_domain_dns'],
  ['/arion/analytics/report?siteId=x&type=monthly_summary', 'arion_analytics_reports'],
  ['/arion/hosting/pagespeed?siteId=x', 'arion_hosting_performance'],
  ['/arion/analytics/insights?siteId=x', 'arion_ia_insights_reports'],
  ['/arion/analytics?siteId=x', 'arion_analytics_overview'],
  ['/arion/website-analytics/GOOGLE?siteId=x', 'arion_analytics_overview'],
  [`${S}/plugin/ga4/set`, 'arion_analytics_overview'],
  ['/arion/console/google?siteId=x', 'arion_search_performance'],
  ['/arion/console/bing?siteId=x', 'arion_search_bing_copilot'],
  [`${S}/gsc`, 'arion_search_performance'],
  ['/arion/search/performance', 'arion_search_performance'],
  ['/arion/search/url-inspection', 'arion_search_indexing'],
  ['/arion/search/submit-url', 'arion_search_indexing'],
  ['/arion/search/sitemaps', 'arion_search_sitemaps'],
  ['/arion/search/generate-sitemap', 'arion_search_sitemaps'],
  ['/arion/search/indexnow', 'arion_search_bing_indexnow'],
  ['/arion/search/bing/stats', 'arion_search_bing_copilot'],
  ['/arion/bing/status', 'arion_search_bing_copilot'],
  [`${S}/vulnerabilities`, 'arion_website_security_vulnerabilities'],
  [`${S}/plugin/security/wordfence-config`, 'arion_website_security_firewall'],
  ['/arion/staging', 'arion_website_staging'],
  [`${S}/gbp`, 'arion_business_overview'],
  [`${S}/gbp/locations`, 'arion_business_locations'],
  [`${S}/gbp/reviews/r1/reply`, 'arion_business_reviews'],
  ['/arion/business', 'arion_business_overview'],
  ['/arion/business/overview', 'arion_business_overview'],
  ['/arion/business/reviews', 'arion_business_reviews'],
  ['/arion/business/reviews/r1/draft-reply', 'arion_business_reviews'],
  ['/arion/business/posts', 'arion_business_posts'],
  ['/arion/business/services', 'arion_business_services'],
  ['/arion/business/insights', 'arion_business_insights'],
  [`${S}/gbp/insights`, 'arion_business_insights'],
  ['/arion/business/update?siteId=x', 'arion_business_overview'],
  ['/arion/business/media?siteId=x', 'arion_business_overview'],
  ['/arion/business/qanda/q1/answer?siteId=x', 'arion_business_overview'],
  [`${S}/gbp/create-listing`, 'arion_business_overview'],
  ['/arion/business-locations', 'arion_business_locations'],
  ['/arion/my-business/google?siteId=x', 'arion_business_overview'],
  ['/arion/my-business/apple?siteId=x', 'arion_business_apple_overview'],
  ['/arion/my-business/bing?siteId=x', 'arion_business_bing_overview'],
  ['/arion/sites/x/apple/mark-claimed', 'arion_business_apple_overview'],
  ['/arion/review-replies/run', 'arion_business_reviews'],
  [`${S}/intelligence`, 'arion_ia_insights_intelligence'],
  ['/intelligence/arion/platform-pulse/x', 'arion_ia_insights_intelligence'],
];

async function gate(url, getEntitlements, method = 'GET') {
  const req = { method, originalUrl: url, path: url, tenant: { tenantId: TENANT } };
  let status = 200; let body = null; let passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await arionRouteFeatures({ getEntitlements })(req, res, () => { passed = true; });
  return { passed, status, body, req };
}
const quiet = async (fn) => { const e = console.error; const w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

test('every path names the feature key the catalog row says it was mapped from', () => {
  for (const [p, key] of MAP) assert.equal(featureForPath(p)?.key ?? null, key, p);
});

test('every ROUTE_FEATURES key is a real catalog key', () => {
  const keys = new Set(fixtureKeys());
  for (const r of ROUTE_FEATURES) assert.ok(keys.has(r.key), `${r.key} is not in test/fixtures/feature-keys.json`);
});

test('the path\'s key decides: allowed false -> 403 naming the plan; allowed true -> through', async () => {
  for (const [p, key] of MAP.filter(([, k]) => k)) {
    const no = await gate(p, planSaying({ [key]: entry(false, { needs: 'ARION Pro' }) }));
    assert.equal(no.passed, false, p);
    assert.equal(no.status, 403, p);
    assert.deepEqual(no.body, { error: 'feature_not_in_plan', feature: key, needs: 'ARION Pro', message: 'Not in your plan. This needs ARION Pro.' }, p);
    const yes = await gate(p, planSaying({ [key]: entry(true) }));
    assert.equal(yes.passed, true, p);
    assert.equal(yes.req.feature.key, key);
  }
});

test('only the path\'s own key matters: another page switched off does not lock this one', async () => {
  const r = await gate('/arion/business/posts', planSaying({ arion_business_reviews: entry(false), arion_business_posts: entry(true) }));
  assert.equal(r.passed, true);
});

test('undecided: a signed-in read runs; posting a review reply or a post HOLDS; drafting with AI (spend) HOLDS', async () => {
  const und = (k) => planSaying({ [k]: entry(null) });
  assert.equal((await quiet(() => gate('/arion/business/reviews', und('arion_business_reviews')))).passed, true);
  assert.equal((await quiet(() => gate('/arion/staging', und('arion_website_staging'), 'POST'))).passed, true, 'an ordinary write runs');
  const reply = await quiet(() => gate('/arion/business/reviews/r1/reply', und('arion_business_reviews'), 'POST'));
  assert.equal(reply.status, 503);
  const draft = await quiet(() => gate('/arion/business/reviews/r1/draft-reply', und('arion_business_reviews'), 'POST'));
  assert.equal(draft.status, 503);
  const run = await quiet(() => gate('/arion/review-replies/run', und('arion_business_reviews'), 'POST'));
  assert.equal(run.status, 503);
  const post = await quiet(() => gate('/arion/business/posts', und('arion_business_posts'), 'POST'));
  assert.equal(post.status, 503);
});

test('undecided: every write that changes the public Google, Bing or Apple listing HOLDS; reading those pages runs', async () => {
  const und = (k) => planSaying({ [k]: entry(null) });
  const publicWrites = [
    ['/arion/business/update?siteId=x', 'PATCH', 'arion_business_overview'],
    ['/arion/business/media?siteId=x', 'POST', 'arion_business_overview'],
    ['/arion/business/media/m1?siteId=x', 'DELETE', 'arion_business_overview'],
    ['/arion/business/qanda/q1/answer?siteId=x', 'POST', 'arion_business_overview'],
    ['/arion/business/services?siteId=x', 'PUT', 'arion_business_services'],
    ['/arion/business/reviews/r1/reply?siteId=x', 'DELETE', 'arion_business_reviews'],
    ['/arion/business/posts/p1?siteId=x', 'DELETE', 'arion_business_posts'],
    [`${S}/gbp/create-listing`, 'POST', 'arion_business_overview'],
    ['/arion/my-business/google?siteId=x', 'PUT', 'arion_business_overview'],
    ['/arion/my-business/apple?siteId=x', 'PUT', 'arion_business_apple_overview'],
    ['/arion/my-business/bing?siteId=x', 'PUT', 'arion_business_bing_overview'],
  ];
  for (const [p, method, key] of publicWrites) {
    assert.equal(featureForPath(p)?.key, key, p);
    const held = await quiet(() => gate(p, und(key), method));
    assert.equal(held.passed, false, `${method} ${p} must hold on an undecided plan`);
    assert.equal(held.status, 503, p);
    assert.equal(held.body.error, 'plan_not_confirmed', p);
    const read = await quiet(() => gate(p, und(key), 'GET'));
    assert.equal(read.passed, true, `GET ${p} runs on an undecided plan`);
    const ok = await gate(p, planSaying({ [key]: entry(true) }), method);
    assert.equal(ok.passed, true, `${method} ${p} runs when the plan includes it`);
  }
});

test('the menu and the API agree: Analytics Reports and Hosting Performance are refused where the plan lacks them', async () => {
  const reports = await gate('/arion/analytics/report?siteId=x&type=monthly_summary', planSaying({ arion_analytics_reports: entry(false, { needs: 'ARION Business' }), arion_ia_insights_reports: entry(true) }));
  assert.equal(reports.status, 403);
  assert.equal(reports.body.needs, 'ARION Business');
  const psi = await gate('/arion/hosting/pagespeed?siteId=x', planSaying({ arion_hosting_performance: entry(false, { needs: 'ARION Standard' }) }), 'POST');
  assert.equal(psi.status, 403);
  assert.equal(psi.body.feature, 'arion_hosting_performance');
  const insights = await gate('/arion/analytics/insights?siteId=x', planSaying({ arion_analytics_reports: entry(false), arion_ia_insights_reports: entry(true) }));
  assert.equal(insights.passed, true, 'IA Insights reports stay every tier');
});

test('platform-api down: reads run, never a lock-out', async () => {
  const r = await quiet(() => gate(`${S}/gbp/locations`, async () => null));
  assert.equal(r.passed, true);
});

test('an unmapped path is never gated and never asks platform-api', async () => {
  let asked = 0;
  const r = await gate('/arion/pages', async () => { asked++; return null; });
  assert.equal(r.passed, true); assert.equal(asked, 0);
});

test('the old tier table and tier gate are gone (replace means delete)', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'middleware', 'requireArionTier.js')), false);
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.doesNotMatch(index, /requireArionTier/);
  assert.equal((index.match(/requireArionAccess, arionRouteFeatures\(\), /g) || []).length, 2, 'mounted in front of /arion and /intelligence');
  const src = fs.readFileSync(path.join(ROOT, 'middleware', 'arionRouteFeatures.js'), 'utf8');
  assert.doesNotMatch(src, /tier:\s*'(lite|standard|pro|business)'/, 'no tier is stated beside a path');
  for (const f of ['routes/arion.js', 'routes/arion/gbp.js', 'routes/arion/integrations.js', 'lib/gbpReplyRunner.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /meetsMinTier\(/, f);
  }
});
