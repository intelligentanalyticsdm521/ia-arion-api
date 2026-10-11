/**
 * The SEO add-on gate reads WHICH RUNG a surface needs from the feature
 * catalog (arion_seo_* rows, addon 'seo', addon_min_tier), and still reads
 * WHICH RUNG A SITE HAS from arion.site.seo_addon_tier (11 Oct 2026).
 *
 * Runs the REAL middleware/requireSeoAddon.js with the site row and
 * platform-api stubbed, and the REAL Market Monitor / AI search routes'
 * answers through it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSeoAddon, seoFeatureFor, rungMeets, SEO_ROUTE_FEATURES, SEO_DEFAULT_FEATURE } from '../middleware/requireSeoAddon.js';
import { entry, planSaying, fixtureKeys } from './helpers/feature-fakes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SITE = '11111111-2222-4333-8444-555555555555';
const MM = 'arion_seo_market_monitor';
const mmRow = (allowed, over = {}) => entry(allowed, { addon: 'seo', addon_min_tier: 'authority', min_tier: null, needs: allowed === true ? null : 'the ARION SEO add-on (Authority)', ...over });

async function run({ path: p = '/market-monitor', method = 'GET', rung = 'growth', plan }) {
  const gate = requireSeoAddon({ loadSite: async () => ({ seo_addon_tier: rung }), getEntitlements: plan });
  const req = { path: p, method, query: { siteId: SITE }, body: method === 'GET' ? undefined : { siteId: SITE }, tenant: { tenantId: TENANT } };
  let status = 200; let body = null; let passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  const e = console.error; const w = console.warn; console.error = () => {}; console.warn = () => {};
  try { await gate(req, res, () => { passed = true; }); } finally { console.error = e; console.warn = w; }
  return { passed, status, body, req };
}

test('each /seo path names its catalog key; POSTs and the Data API read are spends', () => {
  assert.deepEqual(seoFeatureFor('/market-monitor/watchlist', 'POST'), { key: MM, intent: 'spend' });
  assert.deepEqual(seoFeatureFor('/market-monitor/suggestions', 'GET'), { key: MM, intent: 'spend' });
  assert.deepEqual(seoFeatureFor('/market-monitor', 'GET'), { key: MM, intent: 'read' });
  assert.deepEqual(seoFeatureFor('/market-monitor/watchlist/9', 'DELETE'), { key: MM, intent: 'write' });
  assert.equal(seoFeatureFor('/ai-search').key, 'arion_seo_ai_search');
  assert.equal(seoFeatureFor('/ai-prompts/setup', 'POST').key, 'arion_seo_ai_prompts');
  assert.equal(seoFeatureFor('/keywords/research', 'POST').key, 'arion_seo_keywords');
  assert.equal(seoFeatureFor('/keyword/12').key, 'arion_seo_keywords');
  assert.equal(seoFeatureFor('/rankings').key, 'arion_seo_rankings');
  assert.equal(seoFeatureFor('/audit/page').key, 'arion_seo_site_audit');
  assert.equal(seoFeatureFor('/competitors/add', 'POST').key, 'arion_seo_competitors');
  assert.equal(seoFeatureFor('/diagnostic').key, SEO_DEFAULT_FEATURE);
  const keys = new Set(fixtureKeys());
  for (const k of [...SEO_ROUTE_FEATURES.map((r) => r.key), SEO_DEFAULT_FEATURE]) assert.ok(keys.has(k), k);
});

test('rungMeets: the ladder order only; no rung needed = any rung; an unknown required word never denies', () => {
  assert.equal(rungMeets('starter', null), true);
  assert.equal(rungMeets('growth', 'authority'), false);
  assert.equal(rungMeets('authority', 'authority'), true);
  assert.equal(rungMeets('authority', 'growth'), true);
  assert.equal(rungMeets('essentials', 'growth'), false);
  assert.equal(rungMeets('growth', 'platinum'), true);
});

test('Market Monitor on a Growth site: a read passes with met=false (the route shows its card); a watchlist POST is refused with the plan named', async () => {
  const plan = planSaying({ [MM]: mmRow(false) });
  const read = await run({ plan });
  assert.equal(read.passed, true);
  assert.deepEqual(read.req.seoFeature, { key: MM, required: 'authority', rung: 'growth', met: false, needs: 'the ARION SEO add-on (Authority)' });
  const post = await run({ path: '/market-monitor/watchlist', method: 'POST', plan });
  assert.equal(post.passed, false);
  assert.equal(post.status, 403);
  assert.equal(post.body.error, 'feature_not_in_plan');
  assert.equal(post.body.needs, 'the ARION SEO add-on (Authority)');
});

test('Market Monitor on an Authority site with the plan allowing it: met=true, through', async () => {
  const r = await run({ rung: 'authority', plan: planSaying({ [MM]: mmRow(true) }) });
  assert.equal(r.passed, true);
  assert.equal(r.req.seoFeature.met, true);
});

test('the rung comes from the CATALOG row, not from this repo: lower the row to growth and a Growth site gets in', async () => {
  const r = await run({ rung: 'growth', path: '/market-monitor/watchlist', method: 'POST', plan: planSaying({ [MM]: mmRow(true, { addon_min_tier: 'growth' }) }) });
  assert.equal(r.passed, true);
  const ai = await run({ rung: 'essentials', path: '/ai-search', plan: planSaying({ arion_seo_ai_search: mmRow(true, { addon_min_tier: 'growth' }) }) });
  assert.equal(ai.req.seoFeature.met, false, 'AI search needs the row\'s rung');
});

test('the site\'s rung would do but the business is refused (switched off for it): 403 feature_not_in_plan', async () => {
  const r = await run({ rung: 'authority', plan: planSaying({ [MM]: mmRow(false, { reason: 'switched off for this business', needs: null }) }) });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'feature_not_in_plan');
});

test('undecided plan: a read runs on the site\'s add-on; a spend HOLDS', async () => {
  const plan = planSaying({ [MM]: mmRow(null) });
  assert.equal((await run({ rung: 'authority', plan })).passed, true);
  const spend = await run({ rung: 'authority', path: '/market-monitor/watchlist', method: 'POST', plan });
  assert.equal(spend.status, 503);
  assert.equal(spend.body.error, 'plan_not_confirmed');
});

test('catalog unreadable or the key missing: a read runs on the site\'s add-on alone; a spend HOLDS', async () => {
  for (const plan of [planSaying({}, { catalog: 'unreadable' }), planSaying({ [MM]: undefined }), async () => null]) {
    const read = await run({ rung: 'starter', plan });
    assert.equal(read.passed, true);
    assert.equal(read.req.seoFeature.required, null);
    const spend = await run({ rung: 'starter', path: '/market-monitor/watchlist', method: 'POST', plan });
    assert.equal(spend.status, 503);
  }
});

test('no add-on on the site is still 403 SEO_ADDON_REQUIRED, in plain words with what it needs', async () => {
  const gate = requireSeoAddon({ loadSite: async () => ({ seo_addon_tier: null }), getEntitlements: planSaying({}) });
  let status = 0; let body = null;
  await gate({ path: '/rankings', method: 'GET', query: { siteId: SITE }, tenant: { tenantId: TENANT } },
    { status(s) { status = s; return this; }, json(b) { body = b; return this; } }, () => {});
  assert.equal(status, 403);
  assert.equal(body.error.code, 'SEO_ADDON_REQUIRED');
  assert.equal(body.error.needs, 'the ARION SEO add-on');
  assert.doesNotMatch(body.error.message, /Intelligent Analytics/);
});

test('the Market Monitor and AI search routes ask req.seoFeature, never a rung word of their own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'arion.js'), 'utf8');
  assert.doesNotMatch(src, /tier !== 'authority'/);
  assert.doesNotMatch(src, /tierRank < 2/);
  assert.doesNotMatch(src, /requires the Authority SEO tier/);
  assert.ok((src.match(/req\.seoFeature\?\.met !== true/g) || []).length >= 5, 'market monitor x4 + AI search');
});
