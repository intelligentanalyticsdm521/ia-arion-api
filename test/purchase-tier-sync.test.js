// test/purchase-tier-sync.test.js
//
// Pins lib/purchaseTierSync.js — the writer that routes/onboarding/webhook.js
// (checkout.session.completed / invoice.paid / customer.subscription.updated)
// and routes/arion/sites.js (add-site) use to fill arion.site.seo_addon_tier
// and arion.site.arion_tier from the Stripe purchase. Until 2026-08-21 neither
// column had a writer in the purchase path, so middleware/requireSeoAddon.js
// 403'd paying SEO buyers and requireArionTier resolved every self-serve
// tenant as Lite.
//
// No DB, no Stripe: the pool and the subscription fetch are faked.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEO_ADDON_LADDER, BASE_TIER_LADDER, SITE_TIER_SYNC_SQL,
  seoAddonTierFromProductName, baseTierFromProductName, tiersFromProductNames,
  productNamesFromSubscription, seoAddonTierFromMetadata, baseTierFromMetadata,
  derivePurchaseTiers, buildSiteTierSync, applySiteTierSync,
  syncSiteTiersFromPurchase, syncTenantBySubscription,
} from '../lib/purchaseTierSync.js';

const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SITE = '11111111-2222-4333-8444-555555555555';

// A subscription as stripe.subscriptions.retrieve(id, { expand: ['items.data.price.product'] }) returns it.
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

// ─── name → tier ───────────────────────────────────────────────────────────
test('product names: "ARION SEO - <Tier>" is the add-on, "ARION - <Tier>" the base plan, everything else null', () => {
  assert.equal(seoAddonTierFromProductName('ARION SEO - Starter'), 'starter');
  assert.equal(seoAddonTierFromProductName('ARION SEO - Essentials'), 'essentials');
  assert.equal(seoAddonTierFromProductName('ARION SEO - Growth'), 'growth');
  assert.equal(seoAddonTierFromProductName('ARION SEO - Authority'), 'authority');
  assert.equal(seoAddonTierFromProductName('Arion SEO Starter'), 'starter');      // oliver-api catalog spelling
  assert.equal(seoAddonTierFromProductName('ARION SEO — Growth'), 'growth');       // em dash
  assert.equal(seoAddonTierFromProductName('ARION SEO - Growth (annual)'), 'growth');

  assert.equal(baseTierFromProductName('ARION - Lite'), 'lite');
  assert.equal(baseTierFromProductName('ARION - Standard'), 'standard');
  assert.equal(baseTierFromProductName('ARION - Pro'), 'pro');
  assert.equal(baseTierFromProductName('ARION - Business'), 'business');
  assert.equal(baseTierFromProductName('ARION Business'), 'business');
  assert.equal(baseTierFromProductName('arion - pro'), 'pro');

  // never cross the ladders or the products
  assert.equal(baseTierFromProductName('ARION SEO - Growth'), null);
  assert.equal(seoAddonTierFromProductName('ARION - Pro'), null);
  assert.equal(baseTierFromProductName('ARION - Starter'), null);                 // SEO word is not a base tier
  for (const n of ['OLIVER - Pro', 'SPARK Pro', 'SPARK 10k', 'ARGUS Credits', 'Domain registration: x.com', '', null, undefined]) {
    assert.equal(baseTierFromProductName(n), null, `${n} base`);
    assert.equal(seoAddonTierFromProductName(n), null, `${n} seo`);
  }
});

test('tiersFromProductNames keeps the highest rung per ladder', () => {
  assert.deepEqual(
    tiersFromProductNames(['ARION - Standard', 'ARION SEO - Growth', 'OLIVER - Business', 'ARION SEO - Starter']),
    { seoAddonTier: 'growth', arionTier: 'standard' }
  );
  assert.deepEqual(tiersFromProductNames(['ARION SEO - Essentials', 'ARION SEO - Authority']), { seoAddonTier: 'authority', arionTier: null });
  assert.deepEqual(tiersFromProductNames([]), { seoAddonTier: null, arionTier: null });
  assert.deepEqual(tiersFromProductNames(null), { seoAddonTier: null, arionTier: null });
});

test('productNamesFromSubscription reads expanded product objects only (string product ids are skipped)', () => {
  const s = { items: { data: [{ price: { product: { name: 'ARION - Pro' } } }, { price: { product: 'prod_unexpanded' } }, { plan: { product: { name: 'ARION SEO - Growth' } } }] } };
  assert.deepEqual(productNamesFromSubscription(s), ['ARION - Pro', 'ARION SEO - Growth']);
  assert.deepEqual(productNamesFromSubscription(null), []);
  assert.deepEqual(productNamesFromSubscription({}), []);
});

// ─── metadata → tier ───────────────────────────────────────────────────────
test('metadata: seo / seo_addon / seo_addon_tier and plan; ignored when the session belongs to another product', () => {
  assert.equal(seoAddonTierFromMetadata({ seo: 'Growth' }), 'growth');
  assert.equal(seoAddonTierFromMetadata({ seo_addon_tier: 'authority' }), 'authority');
  assert.equal(seoAddonTierFromMetadata({ seo_addon: 'essentials' }), 'essentials');
  assert.equal(seoAddonTierFromMetadata({ seo: 'gold' }), null);
  assert.equal(seoAddonTierFromMetadata({ seo: '' }), null);
  assert.equal(seoAddonTierFromMetadata(null), null);

  assert.equal(baseTierFromMetadata({ product: 'arion', plan: 'business' }), 'business');
  assert.equal(baseTierFromMetadata({ plan: 'PRO' }), 'pro');
  assert.equal(baseTierFromMetadata({ plan: 'starter' }), null);   // the webhook's legacy default is not a base tier

  // oliver-api single-product session: plan belongs to OLIVER, not ARION
  const oliver = { signup_product: 'oliver', plan: 'pro', seo: 'growth' };
  assert.equal(baseTierFromMetadata(oliver), null);
  assert.equal(seoAddonTierFromMetadata(oliver), null);
});

test('derivePurchaseTiers: metadata wins per column, line items fill what metadata lacks', () => {
  assert.deepEqual(
    derivePurchaseTiers({ metadata: { product: 'arion', plan: 'pro' }, subscription: sub('ARION - Standard', 'ARION SEO - Authority') }),
    { seoAddonTier: 'authority', arionTier: 'pro' }
  );
  assert.deepEqual(derivePurchaseTiers({ metadata: {}, subscription: sub('ARION - Business') }), { seoAddonTier: null, arionTier: 'business' });
  assert.deepEqual(derivePurchaseTiers({ metadata: { seo: 'essentials' } }), { seoAddonTier: 'essentials', arionTier: null });
  assert.deepEqual(derivePurchaseTiers({}), { seoAddonTier: null, arionTier: null });
  assert.deepEqual(derivePurchaseTiers(), { seoAddonTier: null, arionTier: null });
  // subscription metadata is consulted after session metadata
  assert.deepEqual(derivePurchaseTiers({ metadata: null, subscription: { metadata: { plan: 'standard', seo: 'growth' }, items: { data: [] } } }), { seoAddonTier: 'growth', arionTier: 'standard' });
  // oliver-api cart: no per-product metadata at all — line items are the only source
  assert.deepEqual(
    derivePurchaseTiers({ metadata: { ia_signup: '1', ia_signup_cart: '1', cart_products: 'oliver,arion' }, subscription: sub('OLIVER - Standard', 'ARION - Pro', 'ARION SEO - Growth') }),
    { seoAddonTier: 'growth', arionTier: 'pro' }
  );
});

// ─── SQL shape ─────────────────────────────────────────────────────────────
test('SQL shape: one raise-only UPDATE on seo_addon_tier + tier + arion_tier, scoped to the tenant (+ optional site)', () => {
  const b = buildSiteTierSync({ tenantId: TENANT, siteId: SITE, seoAddonTier: 'growth', arionTier: 'pro' });
  assert.equal(b.noop, false);
  assert.deepEqual(b.params, { tenantId: TENANT, siteId: SITE, seoTier: 'growth', seoRank: 3, baseTier: 'pro', baseRank: 3 });

  const q = b.sql;
  assert.equal(q, SITE_TIER_SYNC_SQL);
  assert.match(q, /UPDATE s SET/);
  assert.match(q, /FROM arion\.site s/);
  assert.match(q, /WHERE s\.tenant_id = @tenantId/);
  assert.match(q, /\(@siteId IS NULL OR s\.site_id = @siteId\)/);
  assert.match(q, /seo_addon_tier = CASE WHEN @seoRank\s+> r\.seo_rank\s+THEN @seoTier\s+ELSE s\.seo_addon_tier END/);
  assert.match(q, /tier\s+= CASE WHEN @seoRank\s+> r\.tier_rank THEN @seoTier\s+ELSE s\.tier\s+END/);
  assert.match(q, /arion_tier\s+= CASE WHEN @baseRank > r\.base_rank THEN @baseTier ELSE s\.arion_tier\s+END/);
  assert.match(q, /updated_at\s+= SYSDATETIMEOFFSET\(\)/);
  // ladders rendered in the rank CASEs, in order
  assert.match(q, /WHEN 'starter' THEN 1 WHEN 'essentials' THEN 2 WHEN 'growth' THEN 3 WHEN 'authority' THEN 4 ELSE 0 END/);
  assert.match(q, /WHEN 'lite' THEN 1 WHEN 'standard' THEN 2 WHEN 'pro' THEN 3 WHEN 'business' THEN 4 WHEN 'enterprise' THEN 5 ELSE 0 END/);
  // a row is touched only when something actually rises
  assert.match(q, /AND \(@seoRank > r\.seo_rank OR @seoRank > r\.tier_rank OR @baseRank > r\.base_rank\)/);
  assert.doesNotMatch(q, /INSERT|DELETE|DROP|TRUNCATE/i);
  assert.deepEqual(SEO_ADDON_LADDER, ['starter', 'essentials', 'growth', 'authority']);
  assert.deepEqual(BASE_TIER_LADDER, ['lite', 'standard', 'pro', 'business', 'enterprise']);
});

test('SQL params: an unknown tier binds rank 0 (never beats any stored rung); wrong-ladder words are never written', () => {
  const c = buildSiteTierSync({ tenantId: TENANT, arionTier: 'business' });
  assert.deepEqual(c.params, { tenantId: TENANT, siteId: null, seoTier: null, seoRank: 0, baseTier: 'business', baseRank: 4 });
  assert.equal(c.noop, false);

  const d = buildSiteTierSync({ tenantId: TENANT, seoAddonTier: 'pro', arionTier: 'growth' });
  assert.equal(d.noop, true);
  assert.equal(d.params.seoTier, null);
  assert.equal(d.params.baseTier, null);

  const e = buildSiteTierSync({ tenantId: TENANT, seoAddonTier: ' Authority ' });
  assert.equal(e.params.seoTier, 'authority');
  assert.equal(e.params.seoRank, 4);
});

test('applySiteTierSync binds the six parameters; a noop never touches the pool', async () => {
  const pool = fakePool();
  const r = await applySiteTierSync(pool, { tenantId: TENANT, siteId: null, seoAddonTier: 'authority', arionTier: null });
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].q, SITE_TIER_SYNC_SQL);
  assert.deepEqual(pool.calls[0].inputs, { tenantId: TENANT, siteId: null, seoTier: 'authority', seoRank: 4, baseTier: null, baseRank: 0 });
  assert.deepEqual(r, { updated: 1, seoAddonTier: 'authority', arionTier: null });

  const none = fakePool();
  const r2 = await applySiteTierSync(none, { tenantId: TENANT });
  assert.equal(none.calls.length, 0);
  assert.equal(r2.updated, 0);
});

// ─── entry points ──────────────────────────────────────────────────────────
test('syncSiteTiersFromPurchase: fetches the subscription, derives, writes the one site; never throws', async () => {
  const pool = fakePool();
  let fetched = null;
  const { out } = await quiet(() => syncSiteTiersFromPurchase(pool, {
    tenantId: TENANT, siteId: SITE, metadata: { product: 'arion', plan: 'standard' }, subscriptionId: 'sub_42', source: 'test',
    fetchSubscription: async (id) => { fetched = id; return sub('ARION - Standard', 'ARION SEO - Growth'); },
  }));
  assert.equal(fetched, 'sub_42');
  assert.equal(out.ok, true);
  assert.equal(out.seoAddonTier, 'growth');
  assert.equal(out.arionTier, 'standard');
  assert.equal(out.updated, 1);
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].inputs.siteId, SITE);
  assert.equal(pool.calls[0].inputs.seoTier, 'growth');
  assert.equal(pool.calls[0].inputs.baseTier, 'standard');
});

test('syncSiteTiersFromPurchase: Stripe fetch failure falls back to metadata; nothing derivable = no write; DB failure = ok:false, no throw', async () => {
  const pool = fakePool();
  const { out: a, logged } = await quiet(() => syncSiteTiersFromPurchase(pool, {
    tenantId: TENANT, metadata: { product: 'arion', plan: 'pro' }, subscriptionId: 'sub_x',
    fetchSubscription: async () => { throw new Error('stripe down'); },
  }));
  assert.equal(a.ok, true);
  assert.equal(a.arionTier, 'pro');
  assert.equal(a.seoAddonTier, null);
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].inputs.siteId, null);
  assert.ok(logged.some((l) => /stripe down/.test(l)));

  const untouched = fakePool();
  const { out: b } = await quiet(() => syncSiteTiersFromPurchase(untouched, {
    tenantId: TENANT, metadata: { signup_product: 'oliver', plan: 'pro' },
    fetchSubscription: async () => sub('OLIVER - Pro'),
  }));
  assert.equal(b.ok, true);
  assert.equal(b.updated, 0);
  assert.equal(untouched.calls.length, 0);

  const broken = fakePool(() => { throw new Error('pool down'); });
  const { out: c } = await quiet(() => syncSiteTiersFromPurchase(broken, { tenantId: TENANT, metadata: { product: 'arion', plan: 'pro' } }));
  assert.equal(c.ok, false);
  assert.match(c.error, /pool down/);

  const { out: d } = await quiet(() => syncSiteTiersFromPurchase(fakePool(), { metadata: { plan: 'pro' } }));
  assert.equal(d.ok, false);
});

test('syncTenantBySubscription: no arion.tenant on the subscription → no Stripe call; a match syncs every site of the tenant', async () => {
  let fetched = 0;
  const none = fakePool((q) => (q.includes('arion.tenant') ? { recordset: [] } : null));
  const r1 = await syncTenantBySubscription(none, {
    subscriptionId: 'sub_oliver', source: 'test',
    fetchSubscription: async () => { fetched++; return sub('OLIVER - Pro'); },
  });
  assert.equal(r1.updated, 0);
  assert.match(r1.skipped, /no arion\.tenant/);
  assert.equal(fetched, 0);
  assert.equal(none.calls.length, 1);
  assert.equal(none.calls[0].inputs.subId, 'sub_oliver');
  assert.match(none.calls[0].q, /stripe_subscription_id = @subId/);

  const hit = fakePool((q) => (q.includes('arion.tenant') ? { recordset: [{ tenant_id: TENANT }] } : { rowsAffected: [2] }));
  const { out: r2 } = await quiet(() => syncTenantBySubscription(hit, {
    subscriptionId: { id: 'sub_arion' }, source: 'test',
    fetchSubscription: async () => { fetched++; return sub('ARION - Business', 'ARION SEO - Authority'); },
  }));
  assert.equal(fetched, 1);
  assert.equal(r2.ok, true);
  assert.equal(r2.updated, 2);
  assert.equal(hit.calls.length, 2);
  assert.equal(hit.calls[1].inputs.tenantId, TENANT);
  assert.equal(hit.calls[1].inputs.siteId, null);           // all of the tenant's sites
  assert.equal(hit.calls[1].inputs.seoTier, 'authority');
  assert.equal(hit.calls[1].inputs.baseTier, 'business');

  const r3 = await syncTenantBySubscription(fakePool(), { subscriptionId: null });
  assert.equal(r3.updated, 0);
});
