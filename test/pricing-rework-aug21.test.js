// test/pricing-rework-aug21.test.js
//
// Pins the Brandon-approved 2026-08-21 pricing/tier decisions
// (overnight-report/PRICING_REWORK_DECISIONS_2026-08-21.md):
//   - ARION base prices + NO SEO copy in a base plan (SEO is an add-on)
//   - OLIVER Lite → "Invoicing", re-priced ladder, unbuilt features gone
//   - SPARK bundle totals (volume + feature add-on)
//   - SEO add-on AI engines: Growth = AI Overviews + AI Mode, Authority + ChatGPT + Gemini
//   - Site limits keyed to the BASE tier (highestBaseTier resolver)
//   - requireSeoAddon: no SE Ranking surface without a paid SEO add-on,
//     fail-open on unresolved, provisioning + upsell paths untouched

import test from 'node:test';
import assert from 'node:assert/strict';

import { getCatalog, getPlan, annualPrice } from '../lib/pricing.js';
import { TIER_CONFIG } from '../lib/seoOnboarding.js';
import { highestBaseTier } from '../lib/tierCheck.js';
import { requireSeoAddon, seoAddonDecision, isUngatedSeoPath, SEO_ADDON_TIERS } from '../middleware/requireSeoAddon.js';

const byKey = (product) => Object.fromEntries(getCatalog(product).map((p) => [p.key, p]));
const copyOf = (p) => [p.name, p.description, ...p.features].join(' | ');

// ─── ARION ─────────────────────────────────────────────────────────────────
test('ARION base prices: Lite 19.99 / Standard 34.99 / Pro 69.99 / Business 129.99', () => {
  const c = byKey('arion');
  assert.equal(c.lite.pricing.monthly_usd, 19.99);
  assert.equal(c.standard.pricing.monthly_usd, 34.99);
  assert.equal(c.pro.pricing.monthly_usd, 69.99);
  assert.equal(c.business.pricing.monthly_usd, 129.99);
});

test('ARION base copy carries NO SEO / keyword / ranking / audit / AI-search / Market Monitor claims', () => {
  const forbidden = /\bSEO\b|keyword|rank|backlink|audit|SE Ranking|Market Monitor|ChatGPT|Gemini|AI Search|AI Mode/i;
  for (const p of getCatalog('arion')) {
    assert.doesNotMatch(copyOf(p), forbidden, `${p.key} copy leaks SEO add-on features`);
  }
});

test('ARION tier copy matches the approved bullets', () => {
  const c = byKey('arion');
  assert.deepEqual(c.lite.features, ['AI website builder', 'Managed hosting (domain, DNS, SSL, backups, security monitoring)', 'IA Plugin', 'Forms', 'Basic Core Web Vitals', 'IA Insights website reports']);
  assert.deepEqual(c.standard.features, ['Everything in Lite', 'Google Analytics 4', 'Search Console', 'Bing Webmaster + IndexNow', 'Hosting performance + vulnerability scans', 'My Brand studio']);
  assert.deepEqual(c.pro.features, ['Everything in Standard', 'Google Business Profile suite (locations, reviews, posts, services, performance)', 'Bing Places + Apple Business Connect', 'Staging', 'My Brand Pro', 'IA Insights Intelligence']);
  assert.deepEqual(c.business.features, ['Everything in Pro', '3 sites included (+$29.99/mo per additional site)', 'Full Analytics + Insight Reports', 'My Brand Business']);
});

test('annual = monthly × 12 × 0.90 rounded half-up to the cent (matches every Stripe annual Price)', () => {
  assert.equal(annualPrice(19.99), 215.89);
  assert.equal(annualPrice(34.99), 377.89);
  assert.equal(annualPrice(69.99), 755.89);
  assert.equal(annualPrice(129.99), 1403.89);
  assert.equal(annualPrice(79.99), 863.89);
  assert.equal(annualPrice(179.99), 1943.89);
  assert.equal(annualPrice(349.99), 3779.89);
  assert.equal(byKey('arion').lite.pricing.annual_per_month_usd, 17.99);
});

// ─── OLIVER ────────────────────────────────────────────────────────────────
test('OLIVER: Lite is sold as "Invoicing" (key stays lite) and the ladder is 19.99 / 79.99 / 179.99 / 349.99', () => {
  const c = byKey('oliver');
  assert.equal(c.lite.name, 'Invoicing');
  assert.equal(getPlan('oliver', 'lite').name, 'Invoicing');
  assert.equal(c.lite.pricing.monthly_usd, 19.99);
  assert.equal(c.standard.pricing.monthly_usd, 79.99);
  assert.equal(c.pro.pricing.monthly_usd, 179.99);
  assert.equal(c.business.pricing.monthly_usd, 349.99);
});

test('OLIVER Invoicing copy: 1 seat, quotes/proposals/invoices/deposits, zero jobs', () => {
  const c = byKey('oliver');
  assert.deepEqual(c.lite.features, ['1 seat', 'Quotes + pricebook', 'Proposals', 'Invoices + Stripe payment links', 'Deposits + partial payments', 'Basic 30-day reporting', 'No jobs, portal, or automations']);
  assert.doesNotMatch(copyOf(c.lite), /jobs\/mo|50 jobs/i);
});

test('OLIVER copy names nothing unbuilt: no GPS / route / offline / QuickBooks / Xero / financing; Business has STELLA books', () => {
  for (const p of getCatalog('oliver')) {
    assert.doesNotMatch(copyOf(p), /GPS|route|offline|QuickBooks|Xero|financing|BNPL|coming soon/i, `${p.key} names an unbuilt feature`);
  }
  const biz = byKey('oliver').business;
  assert.ok(biz.features.includes('Books + unit economics via STELLA'));
  assert.ok(biz.features.some((f) => /Multi-location/.test(f)));
  assert.ok(biz.features.some((f) => /Job costing/.test(f)));
  assert.ok(biz.features.some((f) => /Custom automation/.test(f)));
  assert.ok(biz.features.some((f) => /payouts/.test(f)));
  assert.ok(biz.features.some((f) => /audit logs/.test(f)));
});

// ─── SPARK ─────────────────────────────────────────────────────────────────
test('SPARK bundle totals: Standard 19.99, Pro 69.98 (= 19.99 + 49.99), Business 119.98 (= 19.99 + 99.99)', () => {
  const c = byKey('spark');
  assert.equal(c.standard.pricing.monthly_usd, 19.99);
  assert.equal(c.pro.pricing.monthly_usd, 69.98);
  assert.equal(c.business.pricing.monthly_usd, 119.98);
  const cents = (n) => Math.round(n * 100);
  assert.equal(cents(c.pro.pricing.monthly_usd) - cents(c.standard.pricing.monthly_usd), 4999);
  assert.equal(cents(c.business.pricing.monthly_usd) - cents(c.standard.pricing.monthly_usd), 9999);
});

test('SPARK copy: Standard has the form builder + auto-reply flow; Pro keeps SMS; nothing claims My Brand (it lives on ARION)', () => {
  const c = byKey('spark');
  assert.ok(c.standard.features.includes('Forms + form builder (hosted page, iframe embed, QR)'));
  assert.ok(c.standard.features.includes('Website forms flow into your CRM with an automatic reply'));
  assert.ok(!copyOf(c.standard).includes('SMS'));
  assert.ok(c.pro.features.includes('SMS campaigns + inbox'));
  for (const p of getCatalog('spark')) assert.doesNotMatch(copyOf(p), /social scheduler|My Brand/i);
});

// ─── SEO add-on AI engines ─────────────────────────────────────────────────
test('SEO add-on AI engines: Growth = AI Overviews + AI Mode; Authority adds ChatGPT + Gemini; 5 prompts; no Perplexity', () => {
  assert.deepEqual(TIER_CONFIG.starter.ai_engines, []);
  assert.deepEqual(TIER_CONFIG.essentials.ai_engines, []);
  assert.deepEqual(TIER_CONFIG.growth.ai_engines, ['ai_overview', 'ai_mode']);
  assert.deepEqual(TIER_CONFIG.authority.ai_engines, ['ai_overview', 'ai_mode', 'chatgpt', 'gemini']);
  for (const t of Object.values(TIER_CONFIG)) assert.ok(!t.ai_engines.includes('perplexity'));
  // Starter stays minimal (1 competitor, monthly ranks) — carried from feat/spark-sms-pro-gate.
  assert.equal(TIER_CONFIG.starter.competitor_limit, 1);
  assert.equal(TIER_CONFIG.starter.check_freq, 'check_monthly');
  assert.equal(TIER_CONFIG.essentials.check_freq, 'check_weekly');
});

// ─── Base-tier resolver for site limits ────────────────────────────────────
test('highestBaseTier: picks the highest known base tier, ignores SEO-ladder words and garbage, null when nothing resolves', () => {
  assert.equal(highestBaseTier(['business', 'lite']), 'business');
  assert.equal(highestBaseTier(['lite', 'PRO']), 'pro');
  assert.equal(highestBaseTier(['authority', 'starter']), null);   // SEO add-on words are not base tiers
  assert.equal(highestBaseTier([null, undefined, '']), null);
  assert.equal(highestBaseTier([]), null);
  assert.equal(highestBaseTier(['enterprise', 'business']), 'enterprise');
});

// ─── requireSeoAddon ───────────────────────────────────────────────────────
const SITE = '11111111-2222-4333-8444-555555555555';

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
function run(gate, { path = '/rankings', query = {}, body = undefined } = {}) {
  const req = { path, query, body, tenant: { tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } };
  const res = fakeRes();
  let nexted = false;
  return gate(req, res, () => { nexted = true; }).then(() => ({ req, res, nexted }));
}
const quiet = async (fn) => {
  const orig = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try { return { out: await fn(), logged }; } finally { console.error = orig; }
};

test('seoAddonDecision: NULL tier denies, known tier allows, unknown value allows (unresolved), missing row = not_found', () => {
  assert.equal(seoAddonDecision(null).action, 'not_found');
  assert.equal(seoAddonDecision({ seo_addon_tier: null }).action, 'deny');
  assert.equal(seoAddonDecision({ seo_addon_tier: '' }).action, 'deny');
  for (const t of SEO_ADDON_TIERS) assert.equal(seoAddonDecision({ seo_addon_tier: t }).action, 'allow');
  assert.equal(seoAddonDecision({ seo_addon_tier: 'Growth ' }).tier, 'growth');
  const odd = seoAddonDecision({ seo_addon_tier: 'pro' });
  assert.equal(odd.action, 'allow');
  assert.match(odd.reason, /unknown/);
});

test('ungated paths: GET /seo (upsell) and /seo/project/* (provisioning) pass without a lookup', () => {
  assert.ok(isUngatedSeoPath('/'));
  assert.ok(isUngatedSeoPath(''));
  assert.ok(isUngatedSeoPath('/project/create'));
  assert.ok(isUngatedSeoPath('/project/reconfigure'));
  assert.ok(!isUngatedSeoPath('/rankings'));
  assert.ok(!isUngatedSeoPath('/keywords/research'));
  assert.ok(!isUngatedSeoPath('/market-monitor/watchlist'));
  assert.ok(!isUngatedSeoPath('/projects')); // not a provisioning path
});

test('gate: site with no SEO add-on → 403 SEO_ADDON_REQUIRED, route never runs', async () => {
  let looked = 0;
  const gate = requireSeoAddon({ loadSite: async () => { looked++; return { seo_addon_tier: null }; } });
  const { res, nexted } = await run(gate, { query: { siteId: SITE } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'SEO_ADDON_REQUIRED');
  assert.equal(looked, 1);
});

test('gate: paid add-on (any tier) → next(), tier attached; siteId accepted from body too', async () => {
  const gate = requireSeoAddon({ loadSite: async () => ({ seo_addon_tier: 'starter' }) });
  const a = await run(gate, { query: { siteId: SITE } });
  assert.equal(a.nexted, true);
  assert.equal(a.req.seoAddonTier, 'starter');
  const b = await run(gate, { path: '/keywords/research', body: { siteId: SITE, seed: 'detailing' } });
  assert.equal(b.nexted, true);
});

test('gate: missing siteId → 400 (closes the siteId-less keyword-research hole); malformed id → route answers', async () => {
  let looked = 0;
  const gate = requireSeoAddon({ loadSite: async () => { looked++; return { seo_addon_tier: 'growth' }; } });
  const a = await run(gate, { path: '/keywords/research', body: { seed: 'detailing' } });
  assert.equal(a.nexted, false);
  assert.equal(a.res.statusCode, 400);
  assert.equal(a.res.body.error.code, 'MISSING_PARAM');
  const b = await run(gate, { query: { siteId: 'not-a-guid' } });
  assert.equal(b.nexted, true);
  assert.equal(looked, 0);
});

test('gate: site not found for tenant → 404; provisioning + upsell paths skip the lookup entirely', async () => {
  let looked = 0;
  const gate = requireSeoAddon({ loadSite: async () => { looked++; return null; } });
  const a = await run(gate, { query: { siteId: SITE } });
  assert.equal(a.res.statusCode, 404);
  assert.equal(looked, 1);
  const b = await run(gate, { path: '/project/create', body: { siteId: SITE } });
  assert.equal(b.nexted, true);
  const c = await run(gate, { path: '/', query: { siteId: SITE } });
  assert.equal(c.nexted, true);
  assert.equal(looked, 1);
});

test('gate: FAIL OPEN — lookup error or unknown tier value allows and logs; never denies on an unresolved tier', async () => {
  const boom = requireSeoAddon({ loadSite: async () => { throw new Error('pool down'); } });
  const { out: a, logged: la } = await quiet(() => run(boom, { query: { siteId: SITE } }));
  assert.equal(a.nexted, true);
  assert.ok(la.some((l) => /allowing/.test(l)));

  const odd = requireSeoAddon({ loadSite: async () => ({ seo_addon_tier: 'pro' }) });
  const { out: b, logged: lb } = await quiet(() => run(odd, { query: { siteId: SITE } }));
  assert.equal(b.nexted, true);
  assert.ok(lb.some((l) => /unknown seo_addon_tier/.test(l)));
});
