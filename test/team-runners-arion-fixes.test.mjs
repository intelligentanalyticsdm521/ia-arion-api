// test/team-runners-arion-fixes.test.mjs — the review findings on the web
// person's runners (ARGUS employees phase 1, stream 2 fixer pass,
// 2026-10-08). Each test here goes red when its fix is taken out; the
// mutations were run by hand (edit, run, restore) and are named in the commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CHECKS, runChecks, HOLD_KEYWORDS, holdWordHit, unknownChecksFor, HELD_WORDS, OFFER_PATTERNS,
} from '../lib/jobChecks.js';
import { gateJob, runTick } from '../lib/contentAgent/tick.js';
import { applyGovernanceHits, pendingReason, sendInAdvance } from '../lib/contentAgent/runner.js';
import { saveOutput } from '../lib/contentAgent/drafting.js';
import { approveOutput, checksToRerun } from '../lib/contentAgent/decisions.js';
import { mayPublishTo, publishApproved, NOT_LIVE_PUBLISH_WORDS } from '../lib/contentAgent/publisher.js';
import { handoffSocial } from '../lib/contentAgent/socialHandoff.js';
import { businessTimeZone, whenWords } from '../lib/businessTimeZone.js';
import {
  runReviewReplyTick, REVIEW_RUN_WORDS, REVIEW_REPLY_ACTION, runOutcome,
} from '../lib/gbpReplyRunner.js';
import { draftReviewReply } from '../lib/gbpAiReply.js';
import { AGENT_ACTIONS } from '../lib/argus/suiteCeiling.js';
import { makeReviewRepliesRouter, EDIT_CHECKS } from '../routes/arion/reviewReplies.js';
import { makeRunHandler, ownRunSummary } from '../routes/arion/agents.js';
import { normaliseContentRow, normaliseReviewReplyRow } from '../lib/agents/activity.js';
import { normaliseReviewRunRow } from '../lib/agents/runs.js';
import { STARTERS, fakeJobsOn, fakeBriefFor, brief } from './helpers/team-job-fakes.mjs';

const C = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-jobs-contract.json', import.meta.url), 'utf8'));
const T1 = 'a1111111-1111-4111-8111-111111111111';
const T2 = 'b2222222-2222-4222-8222-222222222222';
const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });
const quiet = () => {};

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
          if (got instanceof Error) throw got;
          if (got) return { recordset: got };
          if (/OUTPUT INSERTED\.run_id/.test(text)) return { recordset: [{ run_id: `run-${statements.length}` }] };
          if (/OUTPUT INSERTED\.draft_id/.test(text)) return { recordset: [{ draft_id: `d-${statements.length}` }] };
          if (/OUTPUT INSERTED\.output_id/.test(text)) return { recordset: [{ output_id: `o-${statements.length}` }] };
          if (/@@ROWCOUNT AS affected/.test(text)) return { recordset: [{ affected: 1 }] };
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/* ══ 1. the shared cases (every repo runs them through its own copy) ═══ */

test('offers: every case in the shared fixture', () => {
  const held = (text, allowed = []) => !!CHECKS.offers_from_brief_only(text, { approvedOffers: allowed });
  for (const t of C.offer_cases.held_when_nothing_allowed) assert.equal(held(t), true, `not held: ${t}`);
  for (const t of C.offer_cases.never_an_offer) assert.equal(held(t), false, `held: ${t}`);
  assert.equal(held(C.offer_cases.allowed_inside_its_own_words.text, C.offer_cases.allowed_inside_its_own_words.allowed), false);
  assert.equal(held(C.offer_cases.invented_next_to_allowed.text, C.offer_cases.invented_next_to_allowed.allowed), true);
  // The forms with nothing after "free", or no "free" at all: an allowed one still passes.
  assert.ok(C.offer_cases.allowed_new_forms.length >= 3);
  for (const c of C.offer_cases.allowed_new_forms) {
    assert.equal(held(c.text), true, `not held with nothing allowed: ${c.text}`);
    assert.equal(held(c.text, c.allowed), false, `held although allowed: ${c.text}`);
  }
});

test('offers: the verifier\'s probes are held (is free, on us, waive)', () => {
  const held = (text) => !!CHECKS.offers_from_brief_only(text, { approvedOffers: [] });
  for (const t of ['Your first mow is free', 'Second visit on us', 'We will waive the call-out fee']) assert.equal(held(t), true, `not held: ${t}`);
  assert.equal(held('20% off mowing'), true);
  assert.equal(held('You can count on us'), false);
});

test('the offer patterns are the fixture\'s, and there are eleven', () => {
  assert.deepEqual(OFFER_PATTERNS.map((r) => ({ source: r.source, flags: r.flags })), C.offer_patterns);
  assert.equal(OFFER_PATTERNS.length, 11);
});

test('proof: each quote is judged on its own; an allowed one never carries an invented one through', () => {
  for (const c of C.proof_cases) {
    const fired = !!CHECKS.no_invented_proof(c.text, { approvedProof: c.allowed });
    assert.equal(fired, c.held, `${c.held ? 'not held' : 'held'}: ${c.text}`);
  }
  // The probe from the review, both shapes.
  assert.ok(CHECKS.no_invented_proof('A recent customer said they fixed my fence in one day. A recent client told us we are the best roofer in Iowa.',
    { approvedProof: ['They fixed my fence in one day'] }));
  // Lead words around an allowed item are fine; an addition is not.
  assert.equal(CHECKS.no_invented_proof('One of our customers said they loved the edging.', { approvedProof: ['Loved the edging'] }), null);
  assert.ok(CHECKS.no_invented_proof('One of our customers said they loved the edging and that we are the best crew in the whole state.', { approvedProof: ['Loved the edging'] }));
});

test('proof: words AFTER an allowed quote are invented, whatever their number (the 14:48Z probes)', () => {
  const allowed = ['Best lawn service in town, they were on time'];
  const fired = (text) => !!CHECKS.no_invented_proof(text, { approvedProof: allowed });
  assert.equal(fired('"Best lawn service in town, they were on time, award winning crew" - a happy customer'), true);
  assert.equal(fired('One of our customers said Best lawn service in town, they were on time, voted best Texas.'), true);
  // One trailing word is as invented as three.
  assert.equal(fired('One of our customers said Best lawn service in town, they were on time, guaranteed.'), true);
  // Lead-in words in front, and who said it at the end, are fine.
  assert.equal(fired('A recent customer said it best: Best lawn service in town, they were on time.'), false);
  assert.equal(fired('One of our customers told us Best lawn service in town, they were on time, said Pat.'), false);
  // A lead-in that is not one of the lead-in words is invented too.
  assert.equal(fired('One of our customers said award winning Best lawn service in town, they were on time.'), true);
});

test('proof: a claim word after said/says, words after who said it, words between subject and verb are held (the 15:33Z probes)', () => {
  const allowed = ['Best lawn service in town, they were on time'];
  const fired = (text) => !!CHECKS.no_invented_proof(text, { approvedProof: allowed });
  assert.equal(fired('One of our customers said Best lawn service in town, they were on time, says Top Rated.'), true, 'One of our customers said Best lawn service in town, they were on time, says Top Rated.');
  assert.equal(fired('One of our customers said "Best lawn service in town, they were on time", said Award Winning.'), true, 'One of our customers said "Best lawn service in town, they were on time", said Award Winning.');
  assert.equal(fired('One of our customers said Best lawn service in town, they were on time, says Voted Best.'), true, 'One of our customers said Best lawn service in town, they were on time, says Voted Best.');
  assert.equal(fired('"Best lawn service in town, they were on time" - a happy customer who also called us award winning'), true, '"Best lawn service in town, they were on time" - a happy customer who also called us award winning');
  assert.equal(fired('A recent customer who voted us best in Texas said "Best lawn service in town, they were on time"'), true, 'A recent customer who voted us best in Texas said "Best lawn service in town, they were on time"');
  assert.equal(fired('One of our customers, an award-winning chef, said "Best lawn service in town, they were on time"'), true, 'One of our customers, an award-winning chef, said "Best lawn service in town, they were on time"');
  // Still passing: the plain quote, a lead-in, who said it by name.
  assert.equal(fired('"Best lawn service in town, they were on time" - a happy customer.'), false, '"Best lawn service in town, they were on time" - a happy customer.');
  assert.equal(fired('A recent customer said it best: Best lawn service in town, they were on time.'), false, 'A recent customer said it best: Best lawn service in town, they were on time.');
  assert.equal(fired('One of our customers told us Best lawn service in town, they were on time, said Pat.'), false, 'One of our customers told us Best lawn service in town, they were on time, said Pat.');
});

test('hold words are whole words: praise is never held as a complaint', () => {
  for (const t of C.hold_keyword_cases.hold) assert.ok(HOLD_KEYWORDS.some((k) => holdWordHit(t, k)), `not held: ${t}`);
  for (const t of C.hold_keyword_cases.pass) assert.equal(HOLD_KEYWORDS.find((k) => holdWordHit(t, k)), undefined, `held: ${t}`);
  // Through the check itself, with the review text (the runner's shape).
  assert.deepEqual(runChecks('Thank you!', ['hold_complaint_legal_refund'], { reviewText: 'Very reliable and courteous crew' }).fired, []);
  assert.equal(runChecks('Thank you!', ['hold_complaint_legal_refund'], { reviewText: 'I want a refund' }).fired.length, 1);
});

test('hold words reach the forms whole-word matching missed (fraudulent, disgraceful, non-refundable)', () => {
  const hit = (t) => HOLD_KEYWORDS.some((k) => holdWordHit(t, k));
  for (const t of ['This is fraudulent', 'a disgraceful crew', 'non-refundable deposit']) assert.equal(hit(t), true, `not held: ${t}`);
  assert.equal(hit('Very reliable crew'), false);
});

/* ══ 2. a check is "known" only to the runner that runs it ═════════════ */

test('a blog job whose description adds a review-only check is refused, nothing spent', () => {
  const def = structuredClone(STARTERS['arion.blog_posts']);
  def.steps[2].checks = [...def.steps[2].checks, 'low_star_review_asks'];
  const g = gateJob('arion.blog_posts', { playbook: { def } }, brief({ services: ['Mowing'] }));
  assert.equal(g.ok, false);
  assert.equal(g.rule, 'unknown_check');
  // The check's plain name, and that THIS job can't run it; never its key.
  assert.equal(g.words, 'This job can\'t run its check "Never answer a review of 3 stars or fewer without you", so I did nothing.');
  assert.doesNotMatch(g.words, /low_star_review_asks|ARGUS has no check/);
  assert.deepEqual(unknownChecksFor('arion.blog_posts', ['over_money_limit_asks', 'no_price']), ['over_money_limit_asks']);
  assert.deepEqual(unknownChecksFor('arion.review_replies', ['low_star_review_asks']), []);
});

test('a review job whose description adds a check this runner cannot run fails closed', async () => {
  const def = structuredClone(STARTERS['arion.review_replies']);
  def.steps[2].checks = [...def.steps[2].checks, 'over_money_limit_asks'];
  const drafted = [];
  const pool = recordingPool((text) => (/FROM arion\.site\s+WHERE tenant_id IN/.test(text)
    ? [{ tenant_id: T1, site_id: 's1', arion_tier: 'pro', gbp_location_name: 'l', gbp_oauth_token_ref: 'r' }] : null));
  const s = await runReviewReplyTick(pool, quiet, {
    ownership: ALL_ON, jobsOn: fakeJobsOn({ [T1]: [['arion.review_replies', { def }]] }),
    briefFor: fakeBriefFor(brief({})), api: { fetchReviews: async () => { throw new Error('must not read'); } },
    draft: async () => { drafted.push(1); return { ok: true, draft: 'x' }; },
  });
  assert.equal(drafted.length, 0);
  assert.equal(s.runs[0].outcome, 'failed');
  assert.equal(s.runs[0].words, 'This job can\'t run its check "Never send a quote over your limit without you", so I did nothing.');
});

/* ══ 3. "Run it now" never hands one business another's numbers ═══════ */

test('run now skips the fleet margin report and answers with this business only', async () => {
  const pool = recordingPool();
  await runTick({
    pool, log: quiet, tenantFilter: T1, jobKeys: ['arion.blog_posts'], ownership: ALL_ON,
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), briefFor: fakeBriefFor(brief({ services: ['Mowing'] })),
    doResearch: async () => ({ provider: 'none', capabilities: { provider: 'none' }, rows: [], detail: 't' }),
    cycle: async () => ({ runId: 'r', status: 'completed', outcome: 'selected', drafted: 0, escalated: 0, costUsd: 0, alerts: [] }),
    notify: async () => [],
  });
  assert.equal(pool.statements.some((s) => /price_usd_monthly/.test(s.text) && /GROUP BY/.test(s.text)), false,
    'the margin report reads every business; it must not run for one business\'s button');

  const summary = {
    ran: 1,
    results: [{ tenantId: T1, status: 'completed' }, { tenantId: T2, status: 'completed' }],
    margins: [{ tenantId: T2, priceUsdMonthly: 99, ratio: 0.9 }],
    alerts: [
      { tenantId: T1, failure_mode: 'F3', message: 'mine' },
      { tenantId: T2, failure_mode: 'MARGIN', message: `Tenant ${T2}: agent cost is 90% of their $99/mo price` },
      { tenantId: T1, failure_mode: 'MARGIN', message: 'fleet words' },
    ],
    notifications: [{ tenantId: T2 }],
  };
  const out = ownRunSummary(summary, T1);
  assert.equal(JSON.stringify(out).includes(T2), false, 'another business\'s id is in the answer');
  assert.equal(out.margins, undefined);
  assert.deepEqual(out.alerts.map((a) => a.message), ['mine']);

  const handler = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), tick: async () => summary });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.stringify(res.body).includes(T2), false);
});

test('run now speaks in the jobs\' names, never their keys', async () => {
  const handler = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({}), tick: async () => ({}) });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.message, 'Say which job to run: Blog posts or Social posts.');
});

test('run now keeps productOff for this business, in the shape the Portal reads (productOff.skipped)', async () => {
  const note = "ARION has ended for this business, so the web person didn't write anything. It starts again after a re-subscribe.";
  const summary = {
    ran: 0, results: [], alerts: [],
    productOff: { product: 'arion', mode: 'apply', skipped: [
      { tenantId: T1, reason: 'subscription_ended', ended: true, note },
      { tenantId: T2, reason: 'subscription_ended', ended: true, note: 'theirs' },
    ], held: [], undecided: false },
  };
  const out = ownRunSummary(summary, T1);
  assert.deepEqual(out.productOff, { skipped: [{ ended: true, note }] });
  assert.equal(out.words, note);
  assert.equal(JSON.stringify(out).includes(T2), false, 'another business\'s id is in the answer');
  assert.equal(JSON.stringify(out).includes('subscription_ended'), false, 'a reason code is in the answer');
  // The Portal's runResult reads exactly this: no results + productOff.skipped => not-owned sentence.
  assert.ok(Array.isArray(out.productOff.skipped) && out.productOff.skipped.length === 1 && out.results.length === 0);
  // A business that owns it gets an empty list, never a missing field.
  assert.deepEqual(ownRunSummary({ ran: 1, results: [{ tenantId: T1 }], productOff: { skipped: [] } }, T1).productOff, { skipped: [] });

  const handler = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), tick: async () => summary });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.productOff.skipped, [{ ended: true, note }]);
});

test('a run that throws answers a plain sentence; the exception text stays in the log', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a));
  const secret = 'Login failed for user sa on localhost,1433';
  const handler = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), tick: async () => { throw new Error(secret); } });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, 'Something went wrong on our side, so nothing ran. Try again in a minute.');
  assert.equal(JSON.stringify(res.body).includes(secret), false);
  assert.ok(logged.some((a) => a.some((x) => x instanceof Error && x.message === secret)), 'the error was not logged');

  // The review replies routes: run, approve and skip.
  const boom = () => { throw new Error(secret); };
  const router = makeReviewRepliesRouter({ getPool: async () => recordingPool(boom), jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }), tick: async () => { throw new Error(secret); } });
  const call = async (path, params = {}) => {
    const layer = router.stack.find((l) => l.route && l.route.path === path);
    const r = fakeRes();
    await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, params, body: {}, auth: { name: 'Dana Ruiz' } }, r);
    return r;
  };
  const id = { id: 'd0000000-0000-4000-8000-000000000001' };
  for (const [path, params, words] of [
    ['/run', {}, 'Something went wrong on our side, so nothing ran. Try again in a minute.'],
    ['/:id/approve', id, 'Something went wrong on our side. Try again in a minute.'],
    ['/:id/skip', id, 'Something went wrong on our side. Try again in a minute.'],
  ]) {
    const r = await call(path, params);
    assert.equal(r.statusCode, 500, path);
    assert.equal(r.body.error.message, words, path);
    assert.equal(JSON.stringify(r.body).includes(secret), false, `${path} sent the exception text`);
  }
});

/* ══ 4. review replies: spend limits ═══════════════════════════════════ */

function reviewPool(extra = () => null) {
  return recordingPool((text, inputs) => {
    const x = extra(text, inputs);
    if (x) return x;
    if (/FROM arion\.site\s+WHERE tenant_id IN/.test(text)) return [{ tenant_id: T1, site_id: 's1', arion_tier: 'pro', gbp_location_name: 'l', gbp_oauth_token_ref: 'r' }];
    return null;
  });
}
const REVIEWS = [{ reviewId: 'r5', reviewerName: 'Lee', starRating: 5, comment: 'Great.' }, { reviewId: 'r4', reviewerName: 'Kim', starRating: 4, comment: 'Good.' }];
const reviewDeps = (over = {}) => ({
  ownership: ALL_ON,
  jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }),
  briefFor: fakeBriefFor(brief({})),
  api: { fetchReviews: async () => ({ reviews: REVIEWS }), replyToReview: async () => ({ reply: {} }) },
  ...over,
});

test('the platform\'s spend switch off stops the review job: no second model call, the run says why', async () => {
  const calls = [];
  const pool = reviewPool();
  const s = await runReviewReplyTick(pool, quiet, reviewDeps({
    draft: async (a) => { calls.push(a); return { ok: false, code: 'argus_spend_disabled' }; },
  }));
  assert.equal(calls.length, 1, 'one refused call, then this business stops');
  assert.equal(s.runs[0].outcome, 'blocked');
  assert.equal(s.runs[0].words, REVIEW_RUN_WORDS.SPEND_OFF);
});

test('the job spends on its own action, and that action is agent spend inside the suite limit', async () => {
  const seen = [];
  await runReviewReplyTick(reviewPool(), quiet, reviewDeps({
    draft: async (a) => { seen.push(a.actionType); return { ok: true, draft: 'Thank you!', costUsd: 0.002 }; },
  }));
  assert.deepEqual([...new Set(seen)], [REVIEW_REPLY_ACTION]);
  assert.ok(AGENT_ACTIONS.includes(REVIEW_REPLY_ACTION));
  assert.ok(!AGENT_ACTIONS.includes('my_brand.review_reply'), 'the owner\'s own button stays outside the agent budget');
});

test('draftReviewReply never drafts for free unless the owner\'s own button asks for the old fallback', async () => {
  const pool = recordingPool((text) => {
    if (/OBJECT_ID\('argus\.credit_grant'/.test(text)) return [{ id: 1 }];
    if (/FROM argus\.action_pricing/.test(text)) return [{ credits_per_call: 1, outlier_cap_usd: 0.05, is_active: 1 }];
    if (/spend_enabled/.test(text)) return [{ value: 'false' }];
    return null;
  });
  let modelCalls = 0;
  const callImpl = async () => { modelCalls += 1; return { text: 'Thanks!', inputTokens: 1, outputTokens: 1 }; };
  const review = { reviewId: 'r1', reviewerName: 'A', starRating: 5, comment: 'Great' };
  const job = await draftReviewReply({ pool, tenantId: T1, review, callImpl, actionType: REVIEW_REPLY_ACTION });
  assert.equal(job.ok, false);
  assert.equal(job.code, 'argus_spend_disabled');
  assert.equal(modelCalls, 0, 'the job called the model with spend switched off');
  const button = await draftReviewReply({ pool, tenantId: T1, review, callImpl, unmeteredFallback: true });
  assert.equal(button.ok, true);
  assert.equal(modelCalls, 1);
});

test('the suite spending limit holds the review job before anything is read or drafted', async () => {
  const calls = { fetched: 0, drafted: 0 };
  const s = await runReviewReplyTick(reviewPool(), quiet, reviewDeps({
    ceiling: async () => ({ allowed: false, verdict: 'breached', message: 'over' }),
    markBreached: async () => {},
    api: { fetchReviews: async () => { calls.fetched += 1; return { reviews: REVIEWS }; }, replyToReview: async () => ({}) },
    draft: async () => { calls.drafted += 1; return { ok: true, draft: 'x' }; },
  }));
  assert.deepEqual(calls, { fetched: 0, drafted: 0 });
  assert.equal(s.runs[0].outcome, 'blocked');
  assert.equal(s.runs[0].words, REVIEW_RUN_WORDS.CEILING);
});

test('what the run spent is written on its row (the governance cost column)', async () => {
  const pool = reviewPool();
  await runReviewReplyTick(pool, quiet, reviewDeps({
    jobsOn: fakeJobsOn({ [T1]: [['arion.review_replies', { mode: 'review' }]] }),
    draft: async () => ({ ok: true, draft: 'Thank you!', costUsd: 0.0025 }),
  }));
  const close = pool.statements.find((x) => /UPDATE arion\.gbp_reply_run/.test(x.text) && /cost_usd = @cost/.test(x.text));
  assert.ok(close, 'the close writes cost_usd');
  assert.equal(close.inputs.cost, 0.005);
});

/* ══ 5. review replies: what History and Run it now say ════════════════ */

test('a business that is not connected, or below Pro, gets a blocked run with the reason', async () => {
  const none = recordingPool();
  const s1 = await runReviewReplyTick(none, quiet, reviewDeps());
  assert.equal(s1.runs[0].outcome, 'blocked');
  assert.equal(s1.runs[0].words, REVIEW_RUN_WORDS.NOT_CONNECTED);
  const basic = recordingPool((text) => (/FROM arion\.site\s+WHERE tenant_id IN/.test(text)
    ? [{ tenant_id: T1, site_id: 's1', arion_tier: 'basic', gbp_location_name: 'l', gbp_oauth_token_ref: 'r' }] : null));
  const s2 = await runReviewReplyTick(basic, quiet, reviewDeps());
  assert.equal(s2.runs[0].words, REVIEW_RUN_WORDS.NOT_PRO);
  const close = basic.statements.find((x) => /UPDATE arion\.gbp_reply_run/.test(x.text));
  assert.deepEqual(JSON.parse(close.inputs.notes), [REVIEW_RUN_WORDS.NOT_PRO]);
});

test('Run it now answers 409 with the reason when the run could not start', async () => {
  const router = makeReviewRepliesRouter({
    getPool: async () => recordingPool(), jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }),
    tick: async () => ({ runs: [{ tenantId: T1, outcome: 'blocked', words: REVIEW_RUN_WORDS.NOT_CONNECTED }] }),
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/run');
  const res = fakeRes();
  await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, REVIEW_RUN_WORDS.NOT_CONNECTED);
});

test('a run that could not read Google closes blocked, and History says so', async () => {
  const pool = reviewPool();
  const s = await runReviewReplyTick(pool, quiet, reviewDeps({ api: { fetchReviews: async () => ({ error: 'down' }) } }));
  assert.equal(s.runs[0].outcome, 'blocked');
  assert.equal(runOutcome({ drafted: 0 }, []), 'nothing_due');
  const label = normaliseReviewRunRow({ run_id: 'r', status: 'completed', outcome: 'nothing_due', notes_json: JSON.stringify([REVIEW_RUN_WORDS.GOOGLE_UNREADABLE]) }).outcome_label;
  assert.equal(label, REVIEW_RUN_WORDS.GOOGLE_UNREADABLE, 'an older nothing_due row with a note says the note');
});

/* ══ 6. review replies: posting is claimed; no false "Send me first" ══ */

test('a reply approved in advance is stored as posting (never held) and moved on from posting', async () => {
  const pool = reviewPool();
  await runReviewReplyTick(pool, quiet, reviewDeps({
    jobsOn: fakeJobsOn({ [T1]: [['arion.review_replies', { mode: 'automatic', modeSetBy: 'Dana Ruiz', modeSetAt: '2026-10-08T12:00:00Z' }]] }),
    api: { fetchReviews: async () => ({ reviews: [REVIEWS[0]] }), replyToReview: async () => ({ reply: {} }) },
    draft: async () => ({ ok: true, draft: 'Thank you, Lee.' }),
  }));
  const ins = pool.statements.find((x) => /INSERT INTO arion\.gbp_reply_draft/.test(x.text));
  assert.equal(ins.inputs.status, 'posting');
  assert.equal(ins.inputs.words, null);
  const move = pool.statements.find((x) => /UPDATE arion\.gbp_reply_draft/.test(x.text) && x.inputs.status === 'posted');
  assert.match(move.text, /status = 'posting'/);
  // A posting row that never came back reads the truth, not "Send me first".
  const stuck = normaliseReviewReplyRow({ draft_id: 'd', status: 'posting', posting_stale: 1, star_rating: 5, created_at: '2026-10-08T12:00:00Z' });
  assert.equal(stuck.held_words, HELD_WORDS.posting_unconfirmed);
  assert.ok(stuck.decide.approve);
  const fresh = normaliseReviewReplyRow({ draft_id: 'd', status: 'posting', posting_stale: 0, star_rating: 5, created_at: '2026-10-08T12:00:00Z' });
  assert.deepEqual(fresh.decide, {});
});

function routeWorld({ claimWins = true, draft = {} } = {}) {
  const calls = { posted: [] };
  const pool = recordingPool((text) => {
    if (/FROM arion\.gbp_reply_draft d\s+JOIN arion\.site/.test(text)) {
      return [{ draft_id: 'd1', site_id: 's1', gbp_review_id: 'r1', reply_text: 'Thank you!', star_rating: 2, review_text: 'I want a refund, you were late.', status: 'held', gbp_oauth_token_ref: 'ref', gbp_location_name: 'loc', ...draft }];
    }
    if (/SET status = 'posting'/.test(text)) return [{ affected: claimWins ? 1 : 0 }];
    return null;
  });
  const api = () => ({
    fetchReviews: async () => ({ reviews: [{ reviewId: 'r1', replyComment: null }] }),
    replyToReview: async (_t, _l, id, text) => { calls.posted.push({ id, text }); return { reply: {} }; },
  });
  const router = makeReviewRepliesRouter({ getPool: async () => pool, api, briefFor: fakeBriefFor(brief({})), jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }), tick: async () => ({}) });
  const call = async (body = {}) => {
    const layer = router.stack.find((l) => l.route && l.route.path === '/:id/approve');
    const res = fakeRes();
    await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, params: { id: 'd0000000-0000-4000-8000-000000000001' }, body, auth: { name: 'Dana Ruiz' } }, res);
    return res;
  };
  return { pool, calls, call };
}

test('approve claims the reply before posting; the loser of a race posts nothing', async () => {
  const lost = routeWorld({ claimWins: false });
  const res = await lost.call();
  assert.equal(res.statusCode, 409);
  assert.equal(lost.calls.posted.length, 0, 'a lost claim posted to Google');
  const won = routeWorld();
  const ok = await won.call();
  assert.equal(ok.statusCode, 200);
  const claimAt = won.pool.statements.findIndex((x) => /SET status = 'posting'/.test(x.text));
  assert.ok(claimAt >= 0, 'no claim');
  const move = won.pool.statements.find((x) => x.inputs.status === 'posted');
  assert.match(move.text, /status = 'posting'/);
});

test('an edited reply on a refund review posts: a person approving IS the ask', async () => {
  assert.ok(!EDIT_CHECKS.includes('hold_complaint_legal_refund'));
  assert.ok(!EDIT_CHECKS.includes('low_star_review_asks'));
  const w = routeWorld();
  const res = await w.call({ body: 'Sorry to hear that, please call us so we can make it right.' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(w.calls.posted.length, 1);
  const priced = await routeWorld().call({ body: 'Sorry! Next visit is only $10.' });
  assert.equal(priced.statusCode, 409, 'the other checks still run on edited words');
});

/* ══ 7. content: governance holds, held reasons, the checks re-run ═════ */

test('a founder-rule hit saves the draft escalated, with its governance flag', async () => {
  const unit = { escalated: false, guardrails: { verdict: 'pass', escalate: false, flags: [], failures: [] }, draft: { title: 't', body_markdown: 'b' } };
  applyGovernanceHits(unit, { escalate: true, hits: [{ name: 'no_pricing_talk', rule_id: 7, matched: 'cheap', pattern: 'cheap' }] });
  assert.equal(unit.guardrails.escalate, true);
  const pool = recordingPool();
  await saveOutput(pool, {
    runId: 'r', tenantId: T1, contentType: 'blog_post', topic: { keyword: 'k' },
    draft: { title: 't', body_markdown: 'b', meta_description: 'm', url_slug: 's' }, guardrails: unit.guardrails,
  });
  const ins = pool.statements.find((x) => /INSERT INTO arion\.content_agent_output/.test(x.text));
  assert.equal(ins.inputs.review, 'escalated');
  assert.ok(JSON.parse(ins.inputs.flags).some((f) => f.rule === 'governance:no_pricing_talk'));
});

test('why a pending draft waited is stored, and the card says THAT, not "Send me first"', async () => {
  const pass = { escalated: false, guardrails: { verdict: 'pass' } };
  assert.equal(pendingReason(pass, { automaticBy: null }), 'send_me_first');
  assert.equal(pendingReason(pass, { automaticBy: null, holdReason: 'always_asks' }), 'always_asks');
  assert.equal(pendingReason(pass, { automaticBy: 'Approved in advance by Dana' }), null);
  assert.equal(pendingReason({ escalated: false, guardrails: { verdict: 'quality_fail' } }, { automaticBy: 'Approved in advance by Dana' }), 'quality');

  const row = (over) => normaliseContentRow({
    output_id: 'o1', content_type: 'blog_post', review_status: 'pending', decision_rule_flags_json: '[]',
    created_at: '2026-10-08T12:00:00Z', job_key: 'arion.blog_posts', ...over,
  });
  assert.equal(row({ held_reason: 'quality' }).held_words, HELD_WORDS.quality);
  assert.equal(row({ held_reason: 'automatic_failed' }).held_words, HELD_WORDS.automatic_failed);
  assert.equal(row({ held_reason: null, decision_rule_flags_json: JSON.stringify([{ rule: 'auto_fail_phrase' }]) }).held_words, HELD_WORDS.quality);
  assert.equal(row({ held_reason: 'send_me_first' }).held_words, HELD_WORDS.send_me_first);
  const auto = row({ review_status: 'approved', approved_in_advance: 1, published_at: null });
  assert.equal(auto.held_words, HELD_WORDS.automatic_publish_failed);
  assert.equal(row({ review_status: 'approved', approved_in_advance: 0, published_at: null }).held_words, HELD_WORDS.not_published);
});

test('an approval in advance that fails records why the draft waited', async () => {
  const marked = [];
  await sendInAdvance(recordingPool(), {
    tenantId: T1, outputId: 'o1', contentType: 'blog_post', automaticBy: 'Approved in advance by Dana',
    doors: {
      approve: async () => { throw new Error('busy'); },
      publish: async () => ({ ok: true }), handoff: async () => ({ ok: true }),
      timeZone: async () => 'America/Chicago', nextDayAt: () => '2026-10-09T15:00:00.000Z',
      markHeld: async (_p, a) => { marked.push(a.reason); },
    },
  });
  assert.deepEqual(marked, ['automatic_failed']);
});

test('approving an escalated draft re-runs the checks its job description added', async () => {
  assert.deepEqual(checksToRerun('arion.blog_posts', JSON.stringify(['hold_complaint_legal_refund'])).includes('hold_complaint_legal_refund'), true);
  const pool = recordingPool((text) => (/FROM arion\.content_agent_output/.test(text) && /SELECT/.test(text)
    ? [{ output_id: 'o1', content_type: 'blog_post', job_key: 'arion.blog_posts', title: 'T', body_markdown: 'B',
      meta_description: 'M', review_status: 'escalated', decision_rule_flags_json: JSON.stringify([{ rule: 'check:no_price' }]),
      checks_json: JSON.stringify(['no_price', 'hold_complaint_legal_refund']) }]
    : null));
  await assert.rejects(
    () => approveOutput(pool, {
      tenantId: T1, outputId: 'o1', actor: 'Dana', edits: { body_markdown: 'We will refund you if you are not happy.' },
      loadCheckCtx: async () => ({ approvedOffers: [], approvedProof: [], namesNeverMention: [], namesYouMayMention: [], competitors: [] }),
      signal: async () => {},
    }),
    (e) => e.status === 409 && e.message === HELD_WORDS.hold_complaint_legal_refund,
  );
});

/* ══ 8. no publishing to a real site from a machine that is not live ═══ */

test('off the live service, a post goes only to a site on this machine', async () => {
  assert.equal(mayPublishTo({ domain: 'azure-coyote-1.hostingersite.com', wp_admin_url: 'https://azure-coyote-1.hostingersite.com/wp-admin' }, {}), false);
  assert.equal(mayPublishTo({ domain: 'localhost:8084', wp_admin_url: 'http://localhost:8084/wp-admin/' }, {}), true);
  assert.equal(mayPublishTo({ domain: 'shop.test' }, {}), true);
  assert.equal(mayPublishTo({ domain: null, wp_admin_url: null }, {}), false, 'no address is not a local site');
  assert.equal(mayPublishTo({ domain: 'example.com' }, { WEBSITE_SITE_NAME: 'arion-api-prod' }), true);

  let composed = 0;
  const pool = recordingPool((text) => {
    if (/FROM arion\.content_agent_output/.test(text) && /SELECT/.test(text)) {
      return [{ output_id: 'o1', site_id: 's1', content_type: 'blog_post', title: 'T', body_markdown: 'B', body_markdown_final: 'B',
        review_status: 'approved', approved_at: '2026-10-08T12:00:00Z', published_at: null }];
    }
    if (/FROM arion\.site/.test(text)) return [{ site_id: 's1', domain: 'real-business.example.com', wp_admin_url: 'https://real-business.example.com/wp-admin' }];
    return null;
  });
  const res = await publishApproved({ pool, tenantId: T1, outputId: 'o1', env: {}, compose: async () => { composed += 1; return { ok: true, postId: 1 }; } });
  assert.equal(res.ok, false);
  assert.equal(res.alert.message, NOT_LIVE_PUBLISH_WORDS);
  assert.equal(composed, 0, 'it reached the website');
  assert.equal(pool.statements.some((x) => /published_at = SYSDATETIMEOFFSET/.test(x.text)), false);
});

/* ══ 9. the social hand-off: claimed first, said on the business's clock */

function handoffPool(state, { claimWins = true } = {}) {
  return recordingPool((text) => {
    if (/SELECT output_id, content_type/.test(text)) return [state];
    if (/SET scheduled_social_post_id = @claim/.test(text)) return [{ affected: claimWins ? 1 : 0 }];
    return null;
  });
}
const ENV = { LUMEN_API_BASE_URL: 'http://lumen.test', LUMEN_INTERNAL_SERVICE_TOKEN: 'tok' };
const okFetch = (calls) => async () => { calls.push(1); return { ok: true, json: async () => ({ data: { post_id: 'p1', status: 'scheduled' } }) }; };

test('two hand-offs at once: the one that loses the claim creates nothing', async () => {
  const calls = [];
  const row = { output_id: 'o1', content_type: 'social_post', review_status: 'approved', body_markdown: 'Hi', scheduled_social_post_id: null };
  const lost = await handoffSocial(handoffPool(row, { claimWins: false }), { tenantId: T1, outputId: 'o1', scheduledFor: '2026-10-09T15:00:00Z', approvedBy: 'Dana', env: ENV, fetchImpl: okFetch(calls), timeZone: async () => 'America/Chicago' });
  assert.equal(lost.ok, false);
  assert.equal(calls.length, 0, 'the loser called the scheduler');
  const fresh = await handoffSocial(handoffPool({ ...row, scheduled_social_post_id: `claim:${new Date().toISOString()}` }), { tenantId: T1, outputId: 'o1', scheduledFor: '2026-10-09T15:00:00Z', env: ENV, fetchImpl: okFetch(calls), timeZone: async () => 'America/Chicago' });
  assert.equal(fresh.ok, false);
  assert.equal(calls.length, 0, 'a hand-off in progress was started again');
});

test('a scheduled post says when on the business\'s clock, never a raw instant', async () => {
  const calls = [];
  const row = { output_id: 'o1', content_type: 'social_post', review_status: 'approved', body_markdown: 'Hi', scheduled_social_post_id: null };
  const pool = recordingPool((text) => {
    if (/SELECT output_id, content_type/.test(text)) return [row];
    if (/SET scheduled_social_post_id = @claim/.test(text)) return [{ affected: 1 }];
    return null;
  });
  // LUMEN answered with no words of its own: arion writes them.
  const out = await handoffSocial(pool, {
    tenantId: T1, outputId: 'o1', scheduledFor: '2026-10-09T15:00:00Z', approvedBy: 'Dana', env: ENV,
    fetchImpl: async () => { calls.push(1); return { ok: true, json: async () => ({ data: { post_id: 'p1' } }) }; },
    timeZone: async () => 'America/Chicago',
  });
  assert.equal(out.ok, true);
  assert.equal(out.words, 'Scheduled for Fri 9 Oct, 10:00.');
  assert.doesNotMatch(out.words, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(whenWords('2026-10-09T15:00:00Z', 'America/Chicago'), 'Fri 9 Oct, 10:00');
});

test('a time-zone read that fails is logged, then the default is used', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const tz = await businessTimeZone(recordingPool(() => new Error('The SELECT permission was denied on the object location')), T1);
    assert.equal(tz, 'America/Chicago');
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1, 'the failed read was swallowed with no trace');
  assert.match(errors[0], /permission was denied/);
});

test('a hand-off that fails gives its claim back, so the card offers Try again', async () => {
  const row = { output_id: 'o1', content_type: 'social_post', review_status: 'approved', body_markdown: 'Hi', scheduled_social_post_id: null };
  const pool = handoffPool(row);
  const out = await handoffSocial(pool, {
    tenantId: T1, outputId: 'o1', scheduledFor: '2026-10-09T15:00:00Z', approvedBy: 'Dana', env: ENV,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, timeZone: async () => 'America/Chicago',
  });
  assert.equal(out.ok, false);
  const claimed = pool.statements.find((x) => /SET scheduled_social_post_id = @claim/.test(x.text));
  const released = pool.statements.find((x) => /SET scheduled_social_post_id = NULL/.test(x.text));
  assert.ok(released, 'the claim was left on the row: the post would never show Try again');
  assert.equal(released.inputs.claim, claimed.inputs.claim, 'only its own claim is cleared');
  assert.ok(pool.statements.some((x) => /handoff_error_plain = @err/.test(x.text)));
});
