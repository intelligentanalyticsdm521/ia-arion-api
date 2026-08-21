// test/phase-b-tier-hygiene-stella.test.js
//
// Phase B (2026-08-22) — PRICING_REWORK_PHASE_B_SCOPE_2026-08-21.md:
//   B1-1  runner placeholder site row stamps arion_tier from arion.tenant.plan
//         (base-ladder words only) and raises from the subscription (best-effort)
//   B1-2/3 provisioning paths sync tiers from the tenant's subscription
//   B1-4  the env-var checkout path (POST /create-session, getStripePriceId,
//         getPlan().stripe_price_*) is gone; GET /catalog stays
//   B1-5  migration 053 is UPDATE-only, idempotent, targets iadm_services
//   B3a   STELLA catalog (Standard 49.99 / Pro 99.99 / Business 199.99, no
//         Lite), Stripe resolution by product name "STELLA - <Tier>", single
//         base line item; GET /catalog?product=stella proxies oliver-api
//
// No DB, no Stripe, no network: pools, fetch and the price index are faked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pricing from '../lib/pricing.js';
import {
  PRODUCTS, getCatalog, getPlan, annualPrice, getStripeCatalog, buildSignupLineItems,
  primePriceIndex, STELLA_PRODUCT_NAME,
} from '../lib/pricing.js';
import { SITE_TIER_SYNC_SQL, syncSiteTiersFromTenantSubscription } from '../lib/purchaseTierSync.js';
import checkoutRouter, { PROXIED_CATALOG_PRODUCTS } from '../routes/onboarding/checkout.js';
import { loadOrCreateSiteRow, arionTierFromTenantPlan } from '../routes/onboarding/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANT = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const SITE = '11111111-2222-4333-8444-555555555555';

const byKey = (product) => Object.fromEntries(getCatalog(product).map((p) => [p.key, p]));
const copyOf = (p) => [p.name, p.description, ...p.features].join(' | ');
const sub = (...names) => ({ id: 'sub_1', metadata: {}, items: { data: names.map((n) => ({ price: { product: { name: n } } })) } });

function fakePool(onQuery) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, value) { inputs[name] = value; return req; },
        async query(q) {
          calls.push({ q, inputs });
          const r = onQuery ? onQuery(q, inputs) : null;
          return r || { recordset: [], rowsAffected: [1] };
        },
      };
      return req;
    },
  };
}

const quiet = async (fn) => {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const logged = [];
  console.error = console.warn = console.log = (...a) => logged.push(a.join(' '));
  try { return { out: await fn(), logged }; } finally { Object.assign(console, orig); }
};

// ─── B3a: STELLA_PLANS ─────────────────────────────────────────────────────
test('STELLA catalog: standard 49.99 / pro 99.99 / business 199.99, annual ×12×0.9, no Lite', () => {
  assert.ok(PRODUCTS.includes('stella'));
  const c = byKey('stella');
  assert.deepEqual(Object.keys(c), ['standard', 'pro', 'business']);
  assert.equal(c.standard.pricing.monthly_usd, 49.99);
  assert.equal(c.pro.pricing.monthly_usd, 99.99);
  assert.equal(c.business.pricing.monthly_usd, 199.99);
  assert.equal(c.standard.pricing.annual_usd, 539.89);
  assert.equal(c.pro.pricing.annual_usd, 1079.89);
  assert.equal(c.business.pricing.annual_usd, 2159.89);
  assert.equal(annualPrice(49.99), 539.89);
  assert.equal(getPlan('stella', 'lite'), null);
  assert.equal(getPlan('stella', 'pro').name, 'Pro');
  assert.equal(getPlan('stella', 'pro').product, 'stella');
  for (const p of getCatalog('stella')) assert.equal(p.product, 'stella');
});

test('STELLA copy: Standard names everything live today with no "rolling out"; Pro/Business blueprint splits say "(rolling out)"', () => {
  const c = byKey('stella');
  const std = copyOf(c.standard);
  for (const live of [/ledger/i, /Plaid/i, /OLIVER invoices/i, /unit economics/i, /close/i, /P&L/i]) {
    assert.match(std, live, `Standard copy must name ${live}`);
  }
  assert.doesNotMatch(std, /rolling out/i);

  assert.ok(c.pro.features.includes('Everything in Standard'));
  assert.ok(c.pro.features.some((f) => /SQL editor \(rolling out\)/.test(f)));
  assert.ok(c.pro.features.some((f) => /Custom Reporting.*\(rolling out\)/.test(f)));
  for (const f of c.pro.features.filter((x) => !/^Everything in/.test(x))) {
    assert.match(f, /\(rolling out\)$/, `Pro bullet must be marked rolling out: ${f}`);
  }

  assert.ok(c.business.features.includes('Everything in Pro'));
  assert.ok(c.business.features.some((f) => /Multi-entity.*\(rolling out\)/.test(f)));
  assert.ok(c.business.features.some((f) => /Database Manager.*\(rolling out\)/.test(f)));
  for (const f of c.business.features.filter((x) => !/^Everything in/.test(x))) {
    assert.match(f, /\(rolling out\)$/, `Business bullet must be marked rolling out: ${f}`);
  }
  // Nothing unbuilt sold as live.
  for (const p of getCatalog('stella')) assert.doesNotMatch(copyOf(p), /payroll|accrual|bill pay|e-fil|QuickBooks|Xero/i);
});

test('STELLA Stripe resolution: product names "STELLA - <Tier>"; catalog + single base line item; interval guard; bad plan', async () => {
  assert.deepEqual(STELLA_PRODUCT_NAME, { standard: 'STELLA - Standard', pro: 'STELLA - Pro', business: 'STELLA - Business' });
  primePriceIndex({
    'STELLA - Standard': { month: { id: 'price_std_m', amount: 49.99 }, year: { id: 'price_std_y', amount: 539.89 } },
    'STELLA - Pro':      { month: { id: 'price_pro_m', amount: 99.99 }, year: { id: 'price_pro_y', amount: 1079.89 } },
    'STELLA - Business': { month: { id: 'price_biz_m', amount: 199.99 } }, // no annual price yet
    'OLIVER - Invoicing': { month: { id: 'price_oli_inv_m', amount: 19.99 } },
  });
  try {
    const cat = await getStripeCatalog('stella');
    assert.deepEqual(cat.map((p) => [p.key, p.product, p.name, p.pricing.monthly_usd]), [
      ['standard', 'stella', 'Standard', 49.99], ['pro', 'stella', 'Pro', 99.99], ['business', 'stella', 'Business', 199.99],
    ]);
    assert.ok(cat[0].features.length > 0);
    const annual = await getStripeCatalog('stella', 'annual');
    assert.equal(annual.find((p) => p.key === 'pro').pricing.monthly_usd, 1079.89);     // year slot
    assert.equal(annual.find((p) => p.key === 'business').pricing.monthly_usd, 199.99); // falls back to month

    const m = await buildSignupLineItems('stella', { plan: 'standard' }, 'monthly');
    assert.deepEqual(m, { line_items: [{ price: 'price_std_m', quantity: 1 }], resolved: { base: 'price_std_m' } });
    const y = await buildSignupLineItems('stella', { plan: 'Pro' }, 'annual');
    assert.deepEqual(y.line_items, [{ price: 'price_pro_y', quantity: 1 }]);

    await assert.rejects(buildSignupLineItems('stella', { plan: 'business' }, 'annual'), (e) => e.code === 'PRICE_UNAVAILABLE');
    await assert.rejects(buildSignupLineItems('stella', { plan: 'lite' }, 'monthly'), (e) => e.code === 'BAD_PLAN');
    await assert.rejects(buildSignupLineItems('stella', {}, 'monthly'), (e) => e.code === 'BAD_PLAN');
    // OLIVER path unchanged by the refactor.
    const o = await buildSignupLineItems('oliver', { plan: 'lite' }, 'monthly');
    assert.deepEqual(o.line_items, [{ price: 'price_oli_inv_m', quantity: 1 }]);
    await assert.rejects(buildSignupLineItems('argus', { plan: 'x' }, 'monthly'), (e) => e.code === 'BAD_PRODUCT');
  } finally {
    primePriceIndex(null);
  }
});

// ─── B1-4: env-var checkout path deleted ───────────────────────────────────
test('B1-4: no STRIPE_PRICE_* resolver — getPlan carries no stripe_price_* fields, getStripePriceId is gone', () => {
  const p = getPlan('arion', 'pro');
  assert.ok(p && !('stripe_price_monthly' in p) && !('stripe_price_annual' in p));
  assert.equal(pricing.getStripePriceId, undefined);
  assert.equal(pricing.resolveStripePrice, undefined);
  // legacy single-arg ARION call still works for session-info.js / webhook.js
  assert.equal(getPlan('business').name, 'Business');
});

test('B1-4: checkout router serves GET /catalog only — POST /create-session is deleted', () => {
  const routes = checkoutRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`);
  assert.deepEqual(routes, ['get /catalog']);
});

// ─── B3a: GET /catalog?product=stella proxies oliver-api ───────────────────
async function callCatalog(query, upstream) {
  const layer = checkoutRouter.stack.find((l) => l.route && l.route.path === '/catalog');
  const handler = layer.route.stack[0].handle;
  const fetched = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (upstream instanceof Error) throw upstream;
    return { ok: true, status: 200, json: async () => upstream, text: async () => '' };
  };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  try {
    await quiet(() => handler({ query }, res));
  } finally {
    globalThis.fetch = origFetch;
  }
  return { res, fetched };
}

test('GET /catalog?product=stella proxies oliver-api /signup/catalog?product=stella and reshapes into the pricing contract', async () => {
  assert.deepEqual(PROXIED_CATALOG_PRODUCTS, ['arion', 'stella']);
  const upstream = { data: { product: 'stella', plans: [
    { key: 'standard', name: 'Standard', description: 'd', features: ['f'], pricing: { monthly_usd: 49.99, annual_usd: 539.89, annual_per_month_usd: 44.99, annual_savings_pct: 10 } },
    { key: 'pro', name: 'Pro', description: 'd', features: [], monthly_usd: 99.99 }, // legacy flat shape → derived
  ] } };
  const { res, fetched } = await callCatalog({ product: 'stella', billing: 'annual' }, upstream);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /\/signup\/catalog\?product=stella&billing=annual$/);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.product, 'stella');
  assert.equal(res.body.meta.source, 'oliver-api');
  assert.ok(!('seoAddons' in res.body.data));
  assert.deepEqual(res.body.data.plans.map((p) => p.product), ['stella', 'stella']);
  assert.deepEqual(res.body.data.plans[0].pricing, { monthly_usd: 49.99, annual_usd: 539.89, annual_per_month_usd: 44.99, annual_savings_usd: 59.99 });
  assert.deepEqual(res.body.data.plans[1].pricing, { monthly_usd: 99.99, annual_usd: 1079.89, annual_per_month_usd: 89.99, annual_savings_usd: 119.99 });
});

test('GET /catalog: arion still proxies product=arion (+ seoAddons passthrough); oliver/spark → 410; unknown → 400; upstream failure → 503', async () => {
  const arion = await callCatalog({ product: 'arion' }, { data: { plans: [{ key: 'lite', name: 'Lite', features: [], pricing: { monthly_usd: 19.99 } }], seoAddons: { starter: { monthly_usd: 24.99 } } } });
  assert.match(arion.fetched[0], /product=arion&billing=monthly$/);
  assert.equal(arion.res.body.data.plans[0].product, 'arion');
  assert.deepEqual(arion.res.body.data.seoAddons, { starter: { monthly_usd: 24.99 } });

  const dflt = await callCatalog({}, { data: { plans: [] } });
  assert.match(dflt.fetched[0], /product=arion/);

  for (const product of ['oliver', 'spark']) {
    const r = await callCatalog({ product }, { data: { plans: [] } });
    assert.equal(r.res.statusCode, 410);
    assert.equal(r.fetched.length, 0);
  }
  const bad = await callCatalog({ product: 'argus' }, { data: { plans: [] } });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.fetched.length, 0);

  const down = await callCatalog({ product: 'stella' }, new Error('ECONNREFUSED'));
  assert.equal(down.res.statusCode, 503);
  assert.equal(down.res.body.error.code, 'CATALOG_UNAVAILABLE');
});

// ─── B1-1: runner placeholder row ──────────────────────────────────────────
test('arionTierFromTenantPlan: base-ladder words only (case-insensitive); SEO-ladder / legacy / empty → null', () => {
  for (const w of ['lite', 'standard', 'pro', 'business', 'enterprise']) {
    assert.equal(arionTierFromTenantPlan(w), w);
    assert.equal(arionTierFromTenantPlan(` ${w.toUpperCase()} `), w);
  }
  for (const v of ['starter', 'essentials', 'growth', 'authority', 'gold', '', null, undefined, 5]) {
    assert.equal(arionTierFromTenantPlan(v), null, `${v}`);
  }
});

function runnerPool({ existing = [], tenant = [], syncThrows = false } = {}) {
  return fakePool((q) => {
    if (/SELECT TOP 1 site_id, domain, status_phase FROM arion\.site/.test(q)) return { recordset: existing };
    if (/FROM arion\.tenant WHERE tenant_id = @tid/.test(q)) return { recordset: tenant };
    if (/INSERT INTO arion\.site/.test(q)) return { recordset: [{ site_id: SITE, domain: 'x.com', status_phase: 'questionnaire_saved' }] };
    if (q === SITE_TIER_SYNC_SQL) { if (syncThrows) throw new Error('sync boom'); return { recordset: [], rowsAffected: [1] }; }
    throw new Error(`unexpected query: ${q.slice(0, 60)}`);
  });
}

test('runner loadOrCreateSiteRow: stamps arion_tier from arion.tenant.plan and raises from the subscription (source=runner)', async () => {
  const pool = runnerPool({ tenant: [{ plan: 'pro', stripe_subscription_id: 'sub_42' }] });
  let fetched = null;
  const { out: site } = await quiet(() => loadOrCreateSiteRow(pool, TENANT, 'x.com', 'purchase', {
    fetchSubscription: async (id) => { fetched = id; return sub('ARION - Pro', 'ARION SEO - Growth'); },
  }));
  assert.equal(site.site_id, SITE);
  const insert = pool.calls.find((c) => /INSERT INTO arion\.site/.test(c.q));
  assert.match(insert.q, /\barion_tier\b/);
  assert.equal(insert.inputs.arionTier, 'pro');
  assert.equal(insert.inputs.tid, TENANT);
  assert.equal(insert.inputs.domainMode, 'purchase');
  assert.equal(fetched, 'sub_42');
  const sync = pool.calls.find((c) => c.q === SITE_TIER_SYNC_SQL);
  assert.ok(sync, 'purchase sync ran');
  assert.equal(sync.inputs.tenantId, TENANT);
  assert.equal(sync.inputs.siteId, SITE);
  assert.equal(sync.inputs.seoTier, 'growth');
  assert.equal(sync.inputs.baseTier, 'pro');
});

test('runner loadOrCreateSiteRow: unmappable plan → no arion_tier in the INSERT (column default applies); no subscription → no sync', async () => {
  const legacy = runnerPool({ tenant: [{ plan: 'growth', stripe_subscription_id: null }] });
  let fetches = 0;
  const { out: a } = await quiet(() => loadOrCreateSiteRow(legacy, TENANT, '', 'byo', { fetchSubscription: async () => { fetches++; return sub('ARION - Pro'); } }));
  assert.equal(a.site_id, SITE);
  const ins = legacy.calls.find((c) => /INSERT INTO arion\.site/.test(c.q));
  assert.doesNotMatch(ins.q, /\barion_tier\b/);
  assert.equal(ins.inputs.arionTier, null);
  assert.equal(ins.inputs.domainMode, 'byo');
  assert.equal(fetches, 0);
  assert.ok(!legacy.calls.some((c) => c.q === SITE_TIER_SYNC_SQL));

  // No arion.tenant row at all (founder-initiated flow).
  const noTenant = runnerPool();
  const { out: b } = await quiet(() => loadOrCreateSiteRow(noTenant, TENANT, '', 'byo'));
  assert.equal(b.site_id, SITE);
  assert.doesNotMatch(noTenant.calls.find((c) => /INSERT/.test(c.q)).q, /\barion_tier\b/);
});

test('runner loadOrCreateSiteRow: existing site is reused (no insert, no sync); a sync failure never fails the runner', async () => {
  const reuse = runnerPool({ existing: [{ site_id: 'EXISTING', domain: 'y.com', status_phase: 'ready' }], tenant: [{ plan: 'pro', stripe_subscription_id: 'sub_1' }] });
  const { out: a } = await quiet(() => loadOrCreateSiteRow(reuse, TENANT, 'y.com', 'byo'));
  assert.equal(a.site_id, 'EXISTING');
  assert.equal(reuse.calls.length, 1);

  const broken = runnerPool({ tenant: [{ plan: 'business', stripe_subscription_id: 'sub_9' }], syncThrows: true });
  const { out: b, logged } = await quiet(() => loadOrCreateSiteRow(broken, TENANT, 'z.com', 'purchase', { fetchSubscription: async () => sub('ARION - Business') }));
  assert.equal(b.site_id, SITE);
  assert.equal(broken.calls.find((c) => /INSERT/.test(c.q)).inputs.arionTier, 'business');
  assert.ok(logged.some((l) => /sync boom/.test(l)));
});

// ─── B1-2 / B1-3: provisioning sync from the tenant's subscription ─────────
test('syncSiteTiersFromTenantSubscription: no arion.tenant / no subscription → skipped without Stripe; a subscription → fetch + raise the one site; never throws', async () => {
  let fetches = 0;
  const none = fakePool((q) => (/FROM arion\.tenant/.test(q) ? { recordset: [] } : null));
  const r1 = await syncSiteTiersFromTenantSubscription(none, { tenantId: TENANT, siteId: SITE, source: 'test', fetchSubscription: async () => { fetches++; return sub('ARION - Pro'); } });
  assert.equal(r1.ok, true);
  assert.equal(r1.updated, 0);
  assert.match(r1.skipped, /no stripe subscription/);
  assert.equal(fetches, 0);
  assert.equal(none.calls.length, 1);
  assert.match(none.calls[0].q, /stripe_subscription_id FROM arion\.tenant WHERE tenant_id = @tenantId/);

  const noSub = fakePool((q) => (/FROM arion\.tenant/.test(q) ? { recordset: [{ stripe_subscription_id: null }] } : null));
  const r2 = await syncSiteTiersFromTenantSubscription(noSub, { tenantId: TENANT, siteId: SITE });
  assert.equal(r2.updated, 0);
  assert.equal(fetches, 0);

  let fetchedId = null;
  const hit = fakePool((q) => (/FROM arion\.tenant/.test(q) ? { recordset: [{ stripe_subscription_id: 'sub_77' }] } : { rowsAffected: [1] }));
  const { out: r3 } = await quiet(() => syncSiteTiersFromTenantSubscription(hit, {
    tenantId: TENANT, siteId: SITE, source: 'create_site',
    fetchSubscription: async (id) => { fetchedId = id; return sub('ARION - Business', 'ARION SEO - Authority'); },
  }));
  assert.equal(fetchedId, 'sub_77');
  assert.equal(r3.ok, true);
  assert.equal(r3.arionTier, 'business');
  assert.equal(r3.seoAddonTier, 'authority');
  const write = hit.calls.find((c) => c.q === SITE_TIER_SYNC_SQL);
  assert.equal(write.inputs.siteId, SITE);
  assert.equal(write.inputs.baseTier, 'business');

  const broken = fakePool(() => { throw new Error('pool down'); });
  const { out: r4 } = await quiet(() => syncSiteTiersFromTenantSubscription(broken, { tenantId: TENANT, siteId: SITE }));
  assert.equal(r4.ok, false);
  assert.match(r4.error, /pool down/);
  const r5 = await syncSiteTiersFromTenantSubscription(fakePool(), {});
  assert.equal(r5.ok, false);
});

// ─── B1-5: migration 053 shape ─────────────────────────────────────────────
test('migration 053: iadm_services, UPDATE-only, idempotent backfill of tier ← seo_addon_tier and raise-only arion_tier ← arion.tenant.plan', () => {
  const file = path.join(__dirname, '..', 'db', 'migrations', '053_site_tier_hygiene.sql');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /TARGET DB: iadm_services/);
  const code = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(DROP|ALTER|DELETE|CREATE|TRUNCATE|INSERT)\b/i, 'additive/UPDATE only');
  const batches = text.split(/^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  assert.equal(batches.length, 2);
  assert.equal((code.match(/\bUPDATE\b/gi) || []).length, 2);

  // (a) legacy SEO-ladder mirror, only where NULL, only ladder words
  assert.match(batches[0], /UPDATE arion\.site\s+SET tier = seo_addon_tier/);
  assert.match(batches[0], /WHERE tier IS NULL/);
  assert.match(batches[0], /LOWER\(seo_addon_tier\) IN \('starter', 'essentials', 'growth', 'authority'\)/);

  // (b) base tier from the tenant plan, raise-only (the column is NOT NULL DEFAULT 'lite')
  assert.match(batches[1], /SET arion_tier = LOWER\(t\.\[plan\]\)/);
  assert.match(batches[1], /FROM arion\.site s\s+JOIN arion\.tenant t ON t\.tenant_id = s\.tenant_id/);
  assert.match(batches[1], /LOWER\(t\.\[plan\]\) IN \('lite', 'standard', 'pro', 'business', 'enterprise'\)/);
  assert.match(batches[1], /r\.plan_rank > r\.site_rank/);
  for (const w of ['lite', 'standard', 'pro', 'business', 'enterprise']) assert.match(batches[1], new RegExp(`WHEN '${w}' THEN`));
  assert.doesNotMatch(batches[1], /seo_addon_tier|starter|growth|authority/, 'never mixes the ladders');
});
