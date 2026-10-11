/**
 * The ARION tier the business PAYS for decides its Pro and Standard features,
 * everywhere, not only behind middleware/requireArionTier.js.
 *
 * Brandon, 11 Oct 2026: "it's by their subscription. ARION pro has different
 * features than ARION lite."
 *
 * arion.site.arion_tier is written raise-only (lib/purchaseTierSync.js), so
 * after a downgrade it still names the old, higher tier. Three places read it
 * on its own and kept handing a downgraded business its old features:
 *   - lib/gbpReplyRunner.js: Google review auto-replies (Pro), a public post on
 *     Google plus a model spend, every day;
 *   - routes/arion/pages.js: the AI page editor (Standard and above), a model
 *     spend, plus the AI offer and price list the editor shows;
 *   - routes/submit.js /public/provision-codes/redeem: the tier the IA plugin
 *     stores (ia_tier) and gates its own features on.
 *
 * Each test RUNS the real code with the database and platform-api stubbed:
 *   site row 'pro' + subscription 'lite'  -> refused (the subscription stands)
 *   subscription undecided / no tier      -> the site row, as before
 *   subscription at or above the tier     -> works as before
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { purchasedArionTier, effectiveArionTier, siteWithPurchasedTier } from '../lib/purchasedArionTier.js';
import { runReviewReplyTick, REVIEW_RUN_WORDS } from '../lib/gbpReplyRunner.js';
import { __test__ as pagesInternals, aiDeps } from '../routes/arion/pages.js';
import submitRouter, { submitDeps } from '../routes/submit.js';
import { fakeJobsOn, fakeBriefFor, brief } from './helpers/team-job-fakes.mjs';

const T1 = 'a1111111-1111-4111-8111-111111111111';
const SITE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const quiet = () => {};

const arion = (tier, { owned = true, decided = true } = {}) => async () => ({
  tenant_id: T1, decided,
  products: { arion: { owned, tier, tier_source: 'stripe', decided } },
});
const unreachable = async () => null;

/* ── the helper ─────────────────────────────────────────────────────────── */

test('purchasedArionTier: a decided tier stands; undecided, not owned and no tier carry no tier', async () => {
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion('lite') }), { state: 'owned', tier: 'lite' });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion('Pro') }), { state: 'owned', tier: 'pro' });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: unreachable }), { state: 'undecided', tier: null });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion('pro', { decided: false }) }), { state: 'undecided', tier: null });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion(null, { owned: false }) }), { state: 'not_owned', tier: null });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion(null) }), { state: 'owned', tier: null });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: arion('website') }), { state: 'owned', tier: null });
  assert.deepEqual(await purchasedArionTier(T1, { getEntitlements: async () => { throw new Error('down'); } }), { state: 'undecided', tier: null });
  assert.equal(effectiveArionTier({ state: 'owned', tier: 'lite' }, 'pro'), 'lite', 'lower than the site row and still stands');
  assert.equal(effectiveArionTier({ state: 'undecided', tier: null }, 'Pro'), 'pro', 'the site row is the fallback');
  assert.equal(effectiveArionTier({ state: 'owned', tier: null }, null), null);
  const site = { site_id: SITE, tenant_id: T1, arion_tier: 'pro', site_token_raw: 'tok' };
  const copy = await siteWithPurchasedTier(site, T1, { getEntitlements: arion('lite') });
  assert.equal(copy.arion_tier, 'lite');
  assert.equal(copy.site_token_raw, 'tok', 'the rest of the row is carried');
  assert.equal(site.arion_tier, 'pro', 'the row itself is not changed');
});

/* ── Google review auto-replies (Pro) ───────────────────────────────────── */

function recordingPool(answer = () => null) {
  const statements = [];
  return {
    statements,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query(text) {
          statements.push({ text, inputs: { ...inputs } });
          const got = answer(text, inputs);
          if (got) return { recordset: got };
          if (/OUTPUT INSERTED\.run_id/.test(text)) return { recordset: [{ run_id: `run-${statements.length}` }] };
          if (/OUTPUT INSERTED\.draft_id/.test(text)) return { recordset: [{ draft_id: `d-${statements.length}` }] };
          if (/@@ROWCOUNT AS affected/.test(text)) return { recordset: [{ affected: 1 }] };
          if (/OBJECT_ID\(@n/.test(text)) return { recordset: [{ id: 1 }] };
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}

const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });

function reviewWorld({ siteTier, getEntitlements }) {
  const posted = [];
  const drafted = [];
  const pool = recordingPool((text) => {
    if (/FROM arion\.site\s+WHERE tenant_id IN/.test(text)) {
      return [{ tenant_id: T1, site_id: 's1', arion_tier: siteTier, gbp_location_name: 'locations/1', gbp_oauth_token_ref: 'ref' }];
    }
    if (/INSERT INTO arion\.gbp_reply_draft/.test(text)) return [{ draft_id: `d${drafted.length + 1}` }];
    return null;
  });
  const deps = {
    ownership: ALL_ON,
    api: {
      fetchReviews: async () => ({ reviews: [{ reviewId: 'r5', reviewerName: 'Lee', starRating: 5, comment: 'Great job.' }] }),
      replyToReview: async (_t, _l, id, text) => { posted.push({ id, text }); return { reply: {} }; },
    },
    jobsOn: fakeJobsOn({ [T1]: [['arion.review_replies', { mode: 'automatic', modeSetBy: 'Dana Ruiz', modeSetAt: '2026-10-08T12:00:00Z', vars: {} }]] }),
    briefFor: fakeBriefFor(brief({ brandVoice: 'Warm.' })),
    draft: async ({ review }) => { drafted.push(review.reviewId); return { ok: true, draft: `Thank you, ${review.reviewerName}.` }; },
    arionTierFor: (tenantId) => purchasedArionTier(tenantId, { getEntitlements }),
  };
  return { pool, deps, posted, drafted };
}

test('review replies: site row says Pro but the business pays for Lite -> nothing written, nothing posted, the run says why', async () => {
  const w = reviewWorld({ siteTier: 'pro', getEntitlements: arion('lite') });
  const s = await runReviewReplyTick(w.pool, quiet, w.deps);
  assert.equal(w.drafted.length, 0, 'no model call');
  assert.equal(w.posted.length, 0, 'nothing posted on Google');
  assert.equal(s.posted, 0);
  assert.equal(s.runs[0].outcome, 'blocked');
  assert.equal(s.runs[0].words, REVIEW_RUN_WORDS.NOT_PRO);
});

test('review replies: the business pays for Pro -> answered as before (even when the site row is behind)', async () => {
  const w = reviewWorld({ siteTier: 'lite', getEntitlements: arion('pro') });
  const s = await runReviewReplyTick(w.pool, quiet, w.deps);
  assert.deepEqual(w.posted.map((p) => p.id), ['r5']);
  assert.equal(s.posted, 1);
});

test('review replies: subscription undecided or carrying no tier -> the site row decides, as before', async () => {
  for (const getEntitlements of [unreachable, arion(null), arion('pro', { decided: false })]) {
    const pro = reviewWorld({ siteTier: 'pro', getEntitlements });
    await runReviewReplyTick(pro.pool, quiet, pro.deps);
    assert.deepEqual(pro.posted.map((p) => p.id), ['r5'], 'Pro site row, no usable subscription tier: answered as before');
    const lite = reviewWorld({ siteTier: 'lite', getEntitlements });
    await runReviewReplyTick(lite.pool, quiet, lite.deps);
    assert.equal(lite.posted.length, 0, 'Lite site row, no usable subscription tier: not answered, as before');
  }
});

/* ── the AI page editor (Standard and above) ────────────────────────────── */

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function preflight({ siteTier, getEntitlements }) {
  const saved = { ...aiDeps };
  let brandLoaded = 0;
  aiDeps.getServicesPool = async () => recordingPool((text) => (/FROM arion\.site/.test(text)
    ? [{ site_id: SITE, tenant_id: T1, arion_tier: siteTier, site_token_raw: 'tok' }] : null));
  aiDeps.siteWithPurchasedTier = (site, tenantId) => siteWithPurchasedTier(site, tenantId, { getEntitlements });
  aiDeps.loadBrandContext = async () => { brandLoaded++; return { business_name: 'Fernbrook' }; };
  try {
    const res = fakeRes();
    const ctx = await pagesInternals.aiPreflight({
      tenant: { tenantId: T1 }, params: { siteId: SITE, pageId: '42' }, body: { instruction: 'Make it friendlier.' },
    }, res);
    return { ctx, res, brandLoaded };
  } finally {
    Object.assign(aiDeps, saved);
  }
}

test('AI editor: site row says Standard but the business pays for Lite -> refused before anything is spent', async () => {
  const r = await preflight({ siteTier: 'standard', getEntitlements: arion('lite') });
  assert.equal(r.ctx, null);
  assert.equal(r.res.statusCode, 403);
  assert.equal(r.res.body.error.code, 'AI_NOT_ON_THIS_PLAN');
  assert.equal(r.res.body.meta.current_tier, 'lite');
  assert.equal(r.brandLoaded, 0, 'nothing past the gate ran');
});

test('AI editor: the business pays for Standard -> carries on, and the tier rides on to the edit itself', async () => {
  const r = await preflight({ siteTier: 'lite', getEntitlements: arion('standard') });
  assert.ok(r.ctx, 'preflight passed');
  assert.equal(r.ctx.site.arion_tier, 'standard');
  assert.equal(r.ctx.site.site_token_raw, 'tok');
  assert.equal(r.brandLoaded, 1);
});

test('AI editor: subscription undecided or carrying no tier -> the site row decides, as before', async () => {
  for (const getEntitlements of [unreachable, arion(null)]) {
    const ok = await preflight({ siteTier: 'standard', getEntitlements });
    assert.ok(ok.ctx, 'Standard site row: carries on');
    const no = await preflight({ siteTier: 'lite', getEntitlements });
    assert.equal(no.res.statusCode, 403, 'Lite site row: refused, as before');
  }
});

/* ── the tier the plugin is told at provisioning ────────────────────────── */

async function redeem({ siteTier, getEntitlements }) {
  const saved = { ...submitDeps };
  const app = express();
  app.use(express.json());
  app.use(submitRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pool = recordingPool((text) => {
      if (/UPDATE arion\.site[\s\S]*OUTPUT inserted\.site_id/.test(text)) return [{ site_id: SITE, tenant_id: T1, arion_tier: siteTier, domain: null }];
      if (/SELECT arion_tier, seo_addon_tier FROM arion\.site/.test(text)) return [{ arion_tier: siteTier, seo_addon_tier: null }];
      return null;
    });
    submitDeps.getServicesPool = async () => pool;
    submitDeps.redeemProvisionCode = async () => ({ ok: true, code_row: { tenant_id: T1, site_id: SITE } });
    submitDeps.firePlatformEvent = async () => 'evt';
    submitDeps.resolveBookingTarget = async () => ({ decided: false, href: '' });
    submitDeps.getEntitlements = getEntitlements;
    const res = await fetch(`${base}/public/provision-codes/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH' }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    Object.assign(submitDeps, saved);
    server.close();
  }
}

test('provisioning: the plugin is told the tier the business pays for, not the raise-only site row', async () => {
  const down = await redeem({ siteTier: 'pro', getEntitlements: arion('lite') });
  assert.equal(down.status, 200);
  assert.equal(down.body.data.tier, 'lite');
  const up = await redeem({ siteTier: 'lite', getEntitlements: arion('business') });
  assert.equal(up.body.data.tier, 'business');
});

test('provisioning: subscription undecided or carrying no tier -> the site row, as before', async () => {
  assert.equal((await redeem({ siteTier: 'pro', getEntitlements: unreachable })).body.data.tier, 'pro');
  assert.equal((await redeem({ siteTier: 'standard', getEntitlements: arion(null) })).body.data.tier, 'standard');
});
