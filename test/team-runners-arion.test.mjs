// test/team-runners-arion.test.mjs — the web person's jobs, wired to their
// switches, their playbooks and the Business Brief.
//
// ARGUS employees, phase 1, stream 2 (CONTRACT_ARGUS_EMPLOYEES_PHASE1_2026-10-08
// §D.7, §E.4, §E.5, §F.1, §G.1-§G.3, §G.5-§G.7, §G.9, §H.3 arion row).
//
// Every guard here has a test that goes red when the guard is removed; the
// mutations run for this build are listed in the stream report.
//
// All fakes: a pool that records every statement, stand-ins for the job-state
// and Brief readers, a fake Google. No database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTick, haltTenant, gateJob, briefInputs } from '../lib/contentAgent/tick.js';
import { goesOutInAdvance, sendInAdvance } from '../lib/contentAgent/runner.js';
import { approveOutput, rejectOutput, DecisionRefused, recheck } from '../lib/contentAgent/decisions.js';
import { handoffSocial } from '../lib/contentAgent/socialHandoff.js';
import { nextDayAt } from '../lib/businessTimeZone.js';
import {
  runChecks, HELD_WORDS, RUN_WORDS, approvedInAdvanceWords, effectiveMode, conforms,
  checksFor, briefCitation, PLATFORM_CHECKS, SUPPORTED_ACTIONS,
} from '../lib/jobChecks.js';
import { decideReply, runReviewReplyTick, markReply } from '../lib/gbpReplyRunner.js';
import { makeReviewRepliesRouter } from '../routes/arion/reviewReplies.js';
import { makeRunHandler } from '../routes/arion/agents.js';
import { fakeEnabled, reviewsApi } from '../lib/gbpFake.js';
import { normaliseContentRow, normaliseReviewReplyRow, loadArionActivity, isWaiting } from '../lib/agents/activity.js';
import { normaliseRunRow, normaliseReviewRunRow } from '../lib/agents/runs.js';
import {
  STARTERS, fakeJobsOn, JOBS_UNREADABLE, fakeBriefFor, BRIEF_UNREADABLE, brief, BRIEF_WITH_SERVICES,
} from './helpers/team-job-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1 = 'a1111111-1111-4111-8111-111111111111';
const T2 = 'b2222222-2222-4222-8222-222222222222';
const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });

/* ── a pool that records every statement ─────────────────────────────── */
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
          if (/@@ROWCOUNT AS affected/.test(text)) return { recordset: [{ affected: 1 }] };
          if (/OBJECT_ID\(@n/.test(text)) return { recordset: [{ id: 1 }] };
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}
const quietLog = () => {};
const research = async () => ({ provider: 'none', capabilities: { provider: 'none' }, rows: [{ keyword: 'lawn care tips' }], detail: 'test' });
const okCycle = (calls) => async (args) => { calls.push(args); return { runId: 'r', status: 'completed', outcome: 'selected', drafted: 1, escalated: 0, costUsd: 0, alerts: [] }; };

/* ══ 1. the content tick follows the jobs ═══════════════════════════════ */

test('only businesses with a job on are run; content types follow the jobs, in order', async () => {
  const calls = [];
  const s = await runTick({
    pool: recordingPool(), env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts', 'arion.social_posts'], [T2]: ['arion.social_posts'] }),
    briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.deepEqual(calls.map((c) => `${c.tenantId}:${c.contentType}:${c.jobKey}`), [
    `${T1}:blog_post:arion.blog_posts`, `${T1}:social_post:arion.social_posts`, `${T2}:social_post:arion.social_posts`,
  ]);
  assert.equal(s.ran, 3);
});

test('slots follow the job\'s posts_per_week; no agent row runs with the defaults', async () => {
  const calls = [];
  await runTick({
    pool: recordingPool(), env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: fakeJobsOn({ [T1]: [['arion.blog_posts', { vars: { posts_per_week: 3 } }]] }),
    briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.equal(calls[0].slots, 3);
  assert.equal(calls[0].authorityStage, 'new');
  assert.equal(calls[0].siteId, null);
  assert.equal(calls[0].playbookVersion, 1);
  assert.deepEqual(calls[0].checkNames, PLATFORM_CHECKS['arion.blog_posts']);
});

test('the job state cannot be read → nothing runs, and the summary says why (fail closed)', async () => {
  const calls = [];
  const pool = recordingPool();
  const s = await runTick({
    pool, env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: JOBS_UNREADABLE, briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.equal(calls.length, 0);
  assert.equal(s.jobStateUnreadable, true);
  assert.equal(s.words, RUN_WORDS.JOB_STATE_UNREADABLE);
  assert.equal(pool.statements.length, 0, 'not even the agent rows are read');
});

test('the Brief cannot be read → that business writes nothing; its run row says so', async () => {
  const calls = [];
  const pool = recordingPool();
  const s = await runTick({
    pool, env: {}, ownership: ALL_ON, notify: async () => [], doResearch: async () => { throw new Error('no research'); },
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), briefFor: BRIEF_UNREADABLE, cycle: okCycle(calls),
  });
  assert.equal(calls.length, 0);
  const close = pool.statements.find((x) => /UPDATE arion\.content_agent_run_log/.test(x.text));
  assert.ok(close, 'a run row is closed');
  assert.equal(close.inputs.status, 'failed');
  assert.equal(close.inputs.err, RUN_WORDS.BRIEF_UNREADABLE);
  const open = pool.statements.find((x) => /INSERT INTO arion\.content_agent_run_log/.test(x.text));
  assert.equal(open.inputs.jobKey, 'arion.blog_posts');
  assert.equal(s.results[0].words, RUN_WORDS.BRIEF_UNREADABLE);
});

test('what you sell is not saved → the run closes blocked, with no research and no model call', async () => {
  const calls = [];
  let researched = false;
  const pool = recordingPool();
  const s = await runTick({
    pool, env: {}, ownership: ALL_ON, notify: async () => [],
    doResearch: async () => { researched = true; return research(); },
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }),
    briefFor: fakeBriefFor(brief({ brandVoice: 'Plain.' })), cycle: okCycle(calls),
  });
  assert.equal(calls.length, 0);
  assert.equal(researched, false);
  const close = pool.statements.find((x) => /UPDATE arion\.content_agent_run_log/.test(x.text));
  assert.equal(close.inputs.status, 'completed');
  assert.deepEqual(JSON.parse(close.inputs.flags), [{ rule: 'waiting_for_brief', detail: RUN_WORDS.WAITING_FOR_SERVICES }]);
  assert.equal(s.results[0].outcome, 'blocked');
  // …and the run row reads as "blocked" with the sentence on the History tab.
  const run = normaliseRunRow({ run_id: 'r', status: 'completed', decision_rule_flags_json: close.inputs.flags });
  assert.equal(run.outcome, 'blocked');
  assert.equal(run.outcome_label, RUN_WORDS.WAITING_FOR_SERVICES);
});

test('a services summary alone meets "what you sell"', () => {
  const g = gateJob('arion.blog_posts', { playbook: { def: STARTERS['arion.blog_posts'] } }, brief({ servicesSummary: 'We mow lawns.' }));
  assert.equal(g.ok, true);
});

test('conformance: steps that do not match what this runner can do → failed, nothing written', async () => {
  const def = structuredClone(STARTERS['arion.blog_posts']);
  def.steps[1].action = 'arion.draft_social_post';
  const calls = [];
  const pool = recordingPool();
  await runTick({
    pool, env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: fakeJobsOn({ [T1]: [['arion.blog_posts', { def }]] }), briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.equal(calls.length, 0);
  const close = pool.statements.find((x) => /UPDATE arion\.content_agent_run_log/.test(x.text));
  assert.equal(close.inputs.status, 'failed');
  assert.equal(close.inputs.err, RUN_WORDS.STEPS_MISMATCH);
});

test('a check this repo cannot run → the job does nothing and names it (fail closed)', () => {
  const def = structuredClone(STARTERS['arion.blog_posts']);
  def.steps[2].checks = [...def.steps[2].checks, 'no_collections_language'];
  const g = gateJob('arion.blog_posts', { playbook: { def } }, BRIEF_WITH_SERVICES);
  assert.equal(g.ok, false);
  assert.equal(g.words, 'ARGUS has no check called no_collections_language, so I did nothing.');
});

test('the platform checks are added again whatever the playbook says', () => {
  const def = structuredClone(STARTERS['arion.blog_posts']);
  def.steps[2].checks = ['no_price'];
  assert.deepEqual(checksFor(def, 'arion.blog_posts'), PLATFORM_CHECKS['arion.blog_posts']);
});

test('only Brief fields the playbook reads AND the business saved go into the writing', () => {
  const b = brief({ services: ['Mowing'], brandVoice: 'Plain.', offersAllowed: [{ words: 'Free spring yard check' }], doNotSay: 'cheap' });
  const narrow = briefInputs(b, ['services']);
  assert.deepEqual(narrow.whatWeSell, ['Mowing']);
  assert.equal(narrow.brandVoice, null);
  assert.deepEqual(narrow.approvedOffers, []);
  const wide = briefInputs(b, ['services', 'brandVoice', 'offersAllowed', 'doNotSay']);
  assert.equal(wide.brandVoice, 'Plain.');
  assert.deepEqual(wide.approvedOffers, ['Free spring yard check']);
  assert.deepEqual(briefCitation(b, ['services', 'brandVoice', 'proofAllowed']).used, ['services', 'brandVoice']);
});

test('the citation and the job go onto every draft the tick asks for', async () => {
  const calls = [];
  await runTick({
    pool: recordingPool(), env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.deepEqual(calls[0].briefCited, { version: 7, saved_at: '2026-10-02T14:10:00Z', used: ['services', 'serviceArea'] });
});

test('haltTenant with no agent row INSERTS a halted row (finding F3)', async () => {
  const pool = recordingPool();
  await haltTenant(pool, T1, 'over the ceiling');
  const q = pool.statements[0].text;
  assert.match(q, /MERGE arion\.content_agent_tenant_config/);
  assert.match(q, /WHEN NOT MATCHED THEN\s+INSERT \(tenant_id, halted_at, halted_reason\)/);
  assert.match(q, /WHEN MATCHED AND tgt\.halted_at IS NULL/);
});

/* ══ 2. Automatic, and its mode ═════════════════════════════════════════ */

test('Automatic needs somebody on record: an Automatic row with nobody named reads Send me first', () => {
  assert.equal(effectiveMode({ mode: 'automatic', modeSetBy: 'Dana Ruiz' }), 'automatic');
  assert.equal(effectiveMode({ mode: 'automatic', modeSetBy: '' }), 'review');
  assert.equal(effectiveMode({ mode: 'review', modeSetBy: 'Dana Ruiz' }), 'review');
  assert.equal(approvedInAdvanceWords({ modeSetBy: 'Dana Ruiz', modeSetAt: '2026-10-08T12:00:00Z' }), 'Approved in advance by Dana Ruiz on 8 Oct 2026');
});

test('the tick hands Automatic only to an Automatic job whose last step follows the mode', async () => {
  const calls = [];
  const always = structuredClone(STARTERS['arion.blog_posts']);
  always.steps[3].hold = 'always';
  await runTick({
    pool: recordingPool(), env: {}, ownership: ALL_ON, notify: async () => [], doResearch: research,
    jobsOn: fakeJobsOn({
      [T1]: [['arion.blog_posts', { mode: 'automatic', modeSetBy: 'Dana Ruiz', modeSetAt: '2026-10-08T12:00:00Z' }]],
      [T2]: [['arion.blog_posts', { def: always, mode: 'automatic', modeSetBy: 'Dana Ruiz', modeSetAt: '2026-10-08T12:00:00Z' }]],
    }),
    briefFor: fakeBriefFor(), cycle: okCycle(calls),
  });
  assert.equal(calls.find((c) => c.tenantId === T1).automaticBy, 'Approved in advance by Dana Ruiz on 8 Oct 2026');
  assert.equal(calls.find((c) => c.tenantId === T2).automaticBy, null, "hold: 'always' waits whatever the mode");
});

test('only a unit that is not held and passed quality goes out in advance', () => {
  const by = 'Approved in advance by Dana Ruiz on 8 Oct 2026';
  assert.equal(goesOutInAdvance({ escalated: false, guardrails: { verdict: 'pass' } }, by), true);
  assert.equal(goesOutInAdvance({ escalated: true, guardrails: { verdict: 'escalate' } }, by), false);
  assert.equal(goesOutInAdvance({ escalated: false, guardrails: { verdict: 'quality_fail' } }, by), false);
  assert.equal(goesOutInAdvance({ escalated: false, guardrails: { verdict: 'pass' } }, null), false);
});

test('a blog post approved in advance is approved through the one writer and then published', async () => {
  const seen = [];
  const doors = {
    approve: async (_p, a) => { seen.push(['approve', a]); },
    publish: async (_p, a) => { seen.push(['publish', a]); return { ok: true }; },
    handoff: async () => { throw new Error('not for a blog'); },
    timeZone: async () => 'America/Chicago', nextDayAt,
  };
  const out = await sendInAdvance({}, { tenantId: T1, outputId: 'o1', contentType: 'blog_post', automaticBy: 'Approved in advance by Dana Ruiz on 8 Oct 2026', doors });
  assert.equal(out.approved, true);
  assert.deepEqual(seen.map((x) => x[0]), ['approve', 'publish']);
  assert.equal(seen[0][1].inAdvance, true);
  assert.equal(seen[0][1].actor, 'Approved in advance by Dana Ruiz on 8 Oct 2026');
});

test('a social post approved in advance goes to the scheduler at post_time tomorrow; a failure is said, not hidden', async () => {
  const seen = [];
  const doors = {
    approve: async () => {}, publish: async () => { throw new Error('not for social'); },
    handoff: async (_p, a) => { seen.push(a); return { ok: false, words: 'Your social scheduler did not answer.' }; },
    timeZone: async () => 'America/Chicago', nextDayAt: (tz, t) => `${tz}@${t}`,
  };
  const out = await sendInAdvance({}, { tenantId: T1, outputId: 'o2', contentType: 'social_post', automaticBy: 'X', postTime: '09:30', doors });
  assert.equal(seen[0].scheduledFor, 'America/Chicago@09:30');
  assert.equal(out.alerts[0].code, 'social_handoff_failed');
  assert.equal(out.flags[0].rule, 'automatic_handoff_failed');
});

test('nextDayAt: tomorrow at the time, on the business\'s clock', () => {
  const at = nextDayAt('America/Chicago', '10:00', new Date('2026-10-08T15:00:00Z'));
  assert.equal(at, '2026-10-09T15:00:00.000Z');   // 10:00 CDT = 15:00 UTC
  assert.equal(nextDayAt('Not/AZone', '10:00', new Date('2026-12-08T15:00:00Z')), '2026-12-09T16:00:00.000Z');
});

/* ══ 3. one writer for a decision ═══════════════════════════════════════ */

const row = (over = {}) => ({
  output_id: 'o1', content_type: 'blog_post', job_key: 'arion.blog_posts', title: 'Spring lawn care',
  body_markdown: 'Body text.', meta_description: 'Meta', review_status: 'pending', decision_rule_flags_json: '[]', ...over,
});
const decisionPool = (r, { affected = 1 } = {}) => recordingPool((text) => {
  if (/SELECT output_id, content_type, job_key/.test(text)) return [r];
  if (/@@ROWCOUNT AS affected/.test(text)) return [{ affected }];
  return null;
});

test('an approval in advance records NO learning signal and marks approved_in_advance', async () => {
  const signals = [];
  const pool = decisionPool(row());
  await approveOutput(pool, { tenantId: T1, outputId: 'o1', actor: 'Approved in advance by X', inAdvance: true, signal: async (_p, s) => signals.push(s) });
  assert.equal(signals.length, 0);
  const upd = pool.statements.find((x) => /UPDATE arion\.content_agent_output/.test(x.text));
  assert.equal(upd.inputs.inAdvance, 1);
});

test('a person\'s approval still records the signal', async () => {
  const signals = [];
  await approveOutput(decisionPool(row()), { tenantId: T1, outputId: 'o1', actor: 'dana@x.test', signal: async (_p, s) => signals.push(s) });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalKind, 'approved_as_is');
});

test('the status move is guarded on the status it read and must move exactly one row (finding F2)', async () => {
  const pool = decisionPool(row(), { affected: 0 });
  await assert.rejects(
    () => approveOutput(pool, { tenantId: T1, outputId: 'o1', actor: 'a', signal: async () => {} }),
    (e) => e instanceof DecisionRefused && e.status === 409 && e.code === 'RACE',
  );
  const upd = pool.statements.find((x) => /UPDATE arion\.content_agent_output/.test(x.text));
  assert.match(upd.text, /AND review_status = @expected/);
  assert.equal(upd.inputs.expected, 'pending');
});

test('an escalated draft without edits is refused: change the words first', async () => {
  const flags = JSON.stringify([{ rule: 'check:no_price', detail: 'x' }]);
  await assert.rejects(
    () => approveOutput(decisionPool(row({ review_status: 'escalated', decision_rule_flags_json: flags })), { tenantId: T1, outputId: 'o1', actor: 'a', signal: async () => {}, loadCheckCtx: async () => ({}) }),
    (e) => e.status === 409 && e.message === `Change the words first: ${HELD_WORDS.no_price}`,
  );
});

test('an escalated draft with edits that still fire a check is refused with that check\'s sentence', async () => {
  const flags = JSON.stringify([{ rule: 'check:no_price', detail: 'x' }]);
  await assert.rejects(
    () => approveOutput(decisionPool(row({ review_status: 'escalated', decision_rule_flags_json: flags })), {
      tenantId: T1, outputId: 'o1', actor: 'a', signal: async () => {},
      edits: { body_markdown: 'Now only $49 a visit.' }, loadCheckCtx: async () => ({}),
    }),
    (e) => e.status === 409 && e.message === HELD_WORDS.no_price,
  );
});

test('an escalated draft with clean edits is approved as edited', async () => {
  const flags = JSON.stringify([{ rule: 'check:no_price', detail: 'x' }]);
  const out = await approveOutput(decisionPool(row({ review_status: 'escalated', decision_rule_flags_json: flags })), {
    tenantId: T1, outputId: 'o1', actor: 'a', signal: async () => {},
    edits: { body_markdown: 'Ask us for a quote.' }, loadCheckCtx: async () => ({}),
  });
  assert.equal(out.review_status, 'edited');
});

test('an escalated draft is never approved in advance', async () => {
  await assert.rejects(
    () => approveOutput(decisionPool(row({ review_status: 'escalated' })), { tenantId: T1, outputId: 'o1', actor: 'x', inAdvance: true, signal: async () => {} }),
    (e) => e.status === 409,
  );
});

test('an unreadable Brief while checking edits refuses (503), never approves unchecked', async () => {
  await assert.rejects(
    () => approveOutput(decisionPool(row({ review_status: 'escalated' })), {
      tenantId: T1, outputId: 'o1', actor: 'a', signal: async () => {}, edits: { body_markdown: 'New words.' }, loadCheckCtx: async () => null,
    }),
    (e) => e.status === 503,
  );
});

test('skip needs no reason and records the signal', async () => {
  const signals = [];
  const out = await rejectOutput(decisionPool(row()), { tenantId: T1, outputId: 'o1', signal: async (_p, s) => signals.push(s) });
  assert.equal(out.review_status, 'rejected');
  assert.equal(signals[0].signalKind, 'rejected');
});

/* ══ 4. the named checks ════════════════════════════════════════════════ */

const CTX = {
  approvedOffers: ['Free spring yard check'], approvedProof: ['Loved the edging'],
  namesNeverMention: ['Hartley Farms', 'Pat Moore'], namesYouMayMention: ['Pat Moore'], competitors: ['GreenCo'],
};
const fires = (text, name, ctx = CTX) => runChecks(text, [name], ctx).fired.map((f) => f.words);

test('no_price holds a price with its sentence', () => {
  assert.deepEqual(fires('Mowing starts at $40 a visit.', 'no_price'), [HELD_WORDS.no_price]);
  assert.deepEqual(fires('Ask us for a quote.', 'no_price'), []);
});

test('offers: an allowed offer passes; one not in the Brief is held', () => {
  assert.deepEqual(fires('Take 10% off a yearly plan this spring.', 'offers_from_brief_only', { ...CTX, approvedOffers: ['10% off a yearly plan'] }), []);
  assert.deepEqual(fires('Book your free spring yard check today, no charge.', 'offers_from_brief_only'), [HELD_WORDS.offers_from_brief_only], '"no charge" is an offer of its own');
  assert.deepEqual(fires('Get 20% off mowing this month.', 'offers_from_brief_only'), [HELD_WORDS.offers_from_brief_only]);
  assert.deepEqual(fires('Get 20% off mowing this month.', 'offers_from_brief_only', { approvedOffers: [] }), [HELD_WORDS.offers_from_brief_only]);
});

test('offers: an allowed offer next to an invented one does not carry it through, and every match is checked', () => {
  const ctx = { ...CTX, approvedOffers: ['Free spring yard check', '10% off a yearly plan'] };
  assert.deepEqual(fires('Book a free spring yard check. Get 20% off mowing.', 'offers_from_brief_only', ctx), [HELD_WORDS.offers_from_brief_only]);
  assert.deepEqual(fires('Take 10% off a yearly plan, or 20% off mowing.', 'offers_from_brief_only', ctx), [HELD_WORDS.offers_from_brief_only]);
  assert.deepEqual(fires('Take 10% off a yearly plan this month.', 'offers_from_brief_only', ctx), []);
});

test('proof is list-based: allowed proof passes, invented proof is held', () => {
  assert.deepEqual(fires('One of our customers said they loved the edging.', 'no_invented_proof'), []);
  assert.deepEqual(fires('One of our customers said we are the best in town.', 'no_invented_proof'), [HELD_WORDS.no_invented_proof]);
});

test('names: a never-mention name is held unless they said yes in writing', () => {
  assert.deepEqual(fires('We just finished at Hartley Farms.', 'no_names_from_never_name'), [HELD_WORDS.no_names_from_never_name]);
  assert.deepEqual(fires('Thanks to Pat Moore for the kind words.', 'no_names_from_never_name'), []);
  assert.deepEqual(fires('We love hartley farmsteads.', 'no_names_from_never_name'), [], 'whole words only');
});

test('competitors: ANY mention is held, with no critical words needed (finding F5)', () => {
  assert.deepEqual(fires('Unlike GreenCo, we edge every bed.', 'no_competitor_names'), [HELD_WORDS.no_competitor_names]);
  assert.deepEqual(fires('greenco is fine too.', 'no_competitor_names'), [HELD_WORDS.no_competitor_names]);
});

test('ranking promises are held', () => {
  for (const t of ['We will get you on the first page of Google.', 'Rank #1 fast', 'guaranteed top ranking']) {
    assert.deepEqual(fires(t, 'no_ranking_promise'), [HELD_WORDS.no_ranking_promise], t);
  }
});

test('an unknown check name fails the whole check run closed', () => {
  const r = runChecks('text', ['no_price', 'no_such_check'], CTX);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ['no_such_check']);
});

test('recheck runs the job\'s checks and the content agent\'s own escalation rules', () => {
  assert.equal(recheck('Starts at $40', { jobKey: 'arion.blog_posts', checkCtx: CTX }), HELD_WORDS.no_price);
  assert.equal(recheck('A plain post about lawns.', { jobKey: 'arion.blog_posts', checkCtx: CTX }), null);
});

test('each runner\'s supported steps are the contract\'s list', () => {
  assert.deepEqual(SUPPORTED_ACTIONS['arion.blog_posts'], ['arion.pick_topic', 'arion.draft_blog_post', 'arion.publish_blog_post']);
  assert.ok(conforms(STARTERS['arion.blog_posts'], 'arion.blog_posts'));
  assert.ok(conforms(STARTERS['arion.social_posts'], 'arion.social_posts'));
  assert.ok(conforms(STARTERS['arion.review_replies'], 'arion.review_replies'));
  assert.equal(conforms(STARTERS['arion.social_posts'], 'arion.blog_posts'), false);
});

/* ══ 5. the social hand-off ═════════════════════════════════════════════ */

function handoffPool(state) {
  return recordingPool((text) => {
    if (/SELECT output_id, content_type, review_status, body_markdown/.test(text)) return [{ ...state }];
    return null;
  });
}
const ENV = { LUMEN_API_BASE_URL: 'http://lumen.test', LUMEN_INTERNAL_SERVICE_TOKEN: 'tok' };

test('a social approval hands off once; a second call is idempotent', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ data: { post_id: '42', status: 'scheduled', words: 'Scheduled.' } }) }; };
  const state = { output_id: 'o', content_type: 'social_post', review_status: 'approved', body_markdown: 'Hi', body_markdown_final: null, scheduled_social_post_id: null };
  const pool = handoffPool(state);
  const first = await handoffSocial(pool, { tenantId: T1, outputId: 'o', scheduledFor: '2026-10-09T15:00:00Z', approvedBy: 'Dana', fetchImpl, env: ENV });
  assert.equal(first.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://lumen.test/api/v1/internal/my-brand/social/posts');
  assert.deepEqual(posts[0].body, { tenant_id: T1, body: 'Hi', scheduled_for: '2026-10-09T15:00:00.000Z', approved_by: 'Dana' });
  assert.ok(pool.statements.some((x) => /SET scheduled_social_post_id = @post/.test(x.text) && x.inputs.post === '42'));
  const again = await handoffSocial(handoffPool({ ...state, scheduled_social_post_id: '42' }), { tenantId: T1, outputId: 'o', scheduledFor: '2026-10-09T15:00:00Z', fetchImpl, env: ENV });
  assert.equal(again.already, true);
  assert.equal(posts.length, 1, 'no second post');
});

test('a hand-off failure is written to handoff_error_plain and never says scheduled', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({ error: { message: 'Your plan does not include scheduling.' } }) });
  const pool = handoffPool({ output_id: 'o', content_type: 'social_post', review_status: 'approved', body_markdown: 'Hi', scheduled_social_post_id: null });
  const out = await handoffSocial(pool, { tenantId: T1, outputId: 'o', scheduledFor: '2026-10-09T15:00:00Z', fetchImpl, env: ENV });
  assert.equal(out.ok, false);
  assert.equal(out.words, 'Your plan does not include scheduling.');
  assert.ok(pool.statements.some((x) => /SET handoff_error_plain = @err/.test(x.text)));
});

test('no hand-off for a post that is not approved', async () => {
  const out = await handoffSocial(handoffPool({ content_type: 'social_post', review_status: 'pending' }), { tenantId: T1, outputId: 'o', scheduledFor: '2026-10-09T15:00:00Z', fetchImpl: async () => { throw new Error('no call'); }, env: ENV });
  assert.equal(out.ok, false);
});

/* ══ 6. run it now ══════════════════════════════════════════════════════ */

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('run now runs only the named job, for this business only', async () => {
  const ticks = [];
  const handler = makeRunHandler({
    getPool: async () => recordingPool(),
    jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }),
    tick: async (a) => { ticks.push(a); return { ran: 1 }; },
  });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ticks[0].jobKeys, ['arion.blog_posts']);
  assert.equal(ticks[0].tenantFilter, T1);
  assert.equal(ticks[0].triggerSource, 'manual');
});

test('run now refuses a job that is off (409) and an unreadable switch (503)', async () => {
  const off = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({ [T1]: ['arion.blog_posts'] }), tick: async () => { throw new Error('must not run'); } });
  const r1 = fakeRes();
  await off({ tenant: { tenantId: T1 }, body: { job_key: 'arion.social_posts' } }, r1);
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.body.error.message, 'That job is off. Switch it on first.');
  const unread = makeRunHandler({ getPool: async () => recordingPool(), jobsOn: JOBS_UNREADABLE, tick: async () => { throw new Error('must not run'); } });
  const r2 = fakeRes();
  await unread({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, r2);
  assert.equal(r2.statusCode, 503);
  const r3 = fakeRes();
  await off({ tenant: { tenantId: T1 }, body: {} }, r3);
  assert.equal(r3.statusCode, 400);
});

/* ══ 7. Google review replies: the approval step ════════════════════════ */

test('decideReply: the order of the rules', () => {
  const firedPrice = [{ check: 'no_price', words: HELD_WORDS.no_price }];
  assert.equal(decideReply({ stars: 3, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 4 }).reason, 'low_star');
  assert.equal(decideReply({ stars: 1, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 4 }).reason, 'low_star');
  assert.equal(decideReply({ stars: 5, fired: firedPrice, mode: 'automatic', hold: 'by_mode', minStars: 4 }).reason, 'check:no_price');
  assert.equal(decideReply({ stars: 5, fired: [], mode: 'review', hold: 'by_mode', minStars: 4 }).reason, 'send_me_first');
  assert.equal(decideReply({ stars: 5, fired: [], mode: 'automatic', hold: 'always', minStars: 4 }).reason, 'always_asks');
  assert.equal(decideReply({ stars: 5, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 4 }).status, 'post');
  assert.equal(decideReply({ stars: 4, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 5 }).reason, 'not_automatic_stars');
  assert.equal(decideReply({ stars: 4, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 2 }).status, 'post', 'a stored line below 4 is read as 4');
  assert.equal(decideReply({ stars: NaN, fired: [], mode: 'automatic', hold: 'by_mode', minStars: 4 }).reason, 'low_star', 'unreadable stars wait');
});

function reviewWorld({ reviews, mode = 'automatic', vars = {}, briefFields = { brandVoice: 'Warm.' }, already = [] }) {
  const posted = [];
  const drafts = [];
  const pool = recordingPool((text, inputs) => {
    if (/SELECT gbp_review_id FROM arion\.gbp_reply_draft/.test(text)) return already.map((id) => ({ gbp_review_id: id }));
    if (/FROM arion\.site\s+WHERE tenant_id IN/.test(text)) return [{ tenant_id: T1, site_id: 's1', arion_tier: 'pro', gbp_location_name: 'locations/1', gbp_oauth_token_ref: 'ref' }];
    if (/INSERT INTO arion\.gbp_reply_draft/.test(text)) { drafts.push(inputs); return [{ draft_id: `d${drafts.length}` }]; }
    return null;
  });
  const api = {
    fetchReviews: async () => ({ reviews }),
    replyToReview: async (_t, _l, id, text) => { posted.push({ id, text }); return { reply: {} }; },
  };
  const deps = {
    ownership: ALL_ON, api,
    jobsOn: fakeJobsOn({ [T1]: [['arion.review_replies', { mode, modeSetBy: mode === 'automatic' ? 'Dana Ruiz' : null, modeSetAt: '2026-10-08T12:00:00Z', vars }]] }),
    briefFor: fakeBriefFor(brief(briefFields)),
    draft: async ({ review }) => ({ ok: true, draft: review.comment?.includes('PRICE') ? 'It is only $20.' : `Thank you, ${review.reviewerName}.` }),
  };
  return { pool, deps, posted, drafts };
}

test('Automatic: a 2-star review waits; a 5-star one is posted, approved in advance', async () => {
  const w = reviewWorld({ reviews: [
    { reviewId: 'r2', reviewerName: 'Sam', starRating: 2, comment: 'Late twice.' },
    { reviewId: 'r5', reviewerName: 'Lee', starRating: 5, comment: 'Great job.' },
  ] });
  const s = await runReviewReplyTick(w.pool, quietLog, w.deps);
  assert.deepEqual(w.posted.map((p) => p.id), ['r5']);
  assert.equal(w.drafts.find((d) => d.rid === 'r2').reason, 'low_star');
  assert.equal(w.drafts.find((d) => d.rid === 'r2').words, HELD_WORDS.low_star);
  const postedMove = w.pool.statements.find((x) => /UPDATE arion\.gbp_reply_draft/.test(x.text) && x.inputs.status === 'posted');
  assert.equal(postedMove.inputs.by, 'Approved in advance by Dana Ruiz on 8 Oct 2026');
  assert.equal(s.held, 1);
  assert.equal(s.posted, 1);
});

test('Send me first: every reply waits, nothing is posted', async () => {
  const w = reviewWorld({ mode: 'review', reviews: [{ reviewId: 'r5', reviewerName: 'Lee', starRating: 5, comment: 'Great.' }] });
  await runReviewReplyTick(w.pool, quietLog, w.deps);
  assert.equal(w.posted.length, 0);
  assert.equal(w.drafts[0].reason, 'send_me_first');
});

test('a fired check holds a reply even on Automatic; a 4-star review with the line at 5 waits', async () => {
  const w = reviewWorld({ vars: { automatic_min_stars: 5 }, reviews: [
    { reviewId: 'rp', reviewerName: 'A', starRating: 5, comment: 'PRICE please' },
    { reviewId: 'r4', reviewerName: 'B', starRating: 4, comment: 'Good.' },
  ] });
  await runReviewReplyTick(w.pool, quietLog, w.deps);
  assert.equal(w.posted.length, 0);
  assert.equal(w.drafts.find((d) => d.rid === 'rp').reason, 'check:no_price');
  assert.equal(w.drafts.find((d) => d.rid === 'r4').reason, 'not_automatic_stars');
});

test('a review that mentions a refund is held even at 5 stars', async () => {
  const w = reviewWorld({ reviews: [{ reviewId: 'rr', reviewerName: 'C', starRating: 5, comment: 'Great, and thanks for the refund.' }] });
  await runReviewReplyTick(w.pool, quietLog, w.deps);
  assert.equal(w.posted.length, 0);
  assert.equal(w.drafts[0].reason, 'check:hold_complaint_legal_refund');
});

test('a review already answered on Google, or already drafted here, is never drafted again', async () => {
  const w = reviewWorld({ already: ['mine'], reviews: [
    { reviewId: 'done', reviewerName: 'A', starRating: 5, comment: 'x', replyComment: 'Thanks!' },
    { reviewId: 'mine', reviewerName: 'B', starRating: 5, comment: 'y' },
  ] });
  await runReviewReplyTick(w.pool, quietLog, w.deps);
  assert.equal(w.drafts.length, 0);
  assert.equal(w.posted.length, 0);
});

test('the job state cannot be read → no review is read or answered', async () => {
  const w = reviewWorld({ reviews: [{ reviewId: 'r5', starRating: 5, comment: 'x' }] });
  const s = await runReviewReplyTick(w.pool, quietLog, { ...w.deps, jobsOn: JOBS_UNREADABLE });
  assert.equal(s.jobStateUnreadable, true);
  assert.equal(w.pool.statements.length, 0);
});

test('the Brief cannot be read → the run closes skipped with the sentence, nothing answered', async () => {
  const w = reviewWorld({ reviews: [{ reviewId: 'r5', starRating: 5, comment: 'x' }] });
  await runReviewReplyTick(w.pool, quietLog, { ...w.deps, briefFor: BRIEF_UNREADABLE });
  const close = w.pool.statements.find((x) => /UPDATE arion\.gbp_reply_run/.test(x.text));
  assert.equal(close.inputs.status, 'skipped');
  assert.deepEqual(JSON.parse(close.inputs.notes), [RUN_WORDS.BRIEF_UNREADABLE_REVIEWS]);
  assert.equal(w.posted.length, 0);
});

test('the reply status move is guarded: held or failed only, exactly one row', async () => {
  const pool = recordingPool((text) => (/@@ROWCOUNT/.test(text) ? [{ affected: 0 }] : null));
  const moved = await markReply(pool, { draftId: 'd1', tenantId: T1, status: 'posted', replyFinal: 'x', decidedBy: 'Dana' });
  assert.equal(moved, false);
  assert.match(pool.statements[0].text, /AND status IN \('held','failed'\)/);
});

/* ══ 8. the review-reply routes ═════════════════════════════════════════ */

function routeWorld({ draft = {}, google = {}, briefRead = fakeBriefFor(brief({})) } = {}) {
  const calls = { posted: [], fetched: 0 };
  const pool = recordingPool((text) => {
    if (/FROM arion\.gbp_reply_draft d\s+JOIN arion\.site/.test(text)) {
      return draft === null ? [] : [{ draft_id: 'd1', site_id: 's1', gbp_review_id: 'r1', reply_text: 'Thank you!', star_rating: 2, review_text: 'Late.', status: 'held', gbp_oauth_token_ref: 'ref', gbp_location_name: 'loc', ...draft }];
    }
    return null;
  });
  const api = () => ({
    fetchReviews: async () => { calls.fetched += 1; return google.error ? { error: 'down' } : { reviews: [{ reviewId: 'r1', replyComment: google.answered ? 'Already!' : null }] }; },
    replyToReview: async (_t, _l, id, text) => { calls.posted.push({ id, text }); return google.refuse ? { error: 'no' } : { reply: {} }; },
  });
  const router = makeReviewRepliesRouter({ getPool: async () => pool, api, briefFor: briefRead, jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }), tick: async () => ({ ran: true }) });
  const call = async (method, url, body = {}) => {
    const layer = router.stack.find((l) => l.route && l.route.path === url.replace(/^\/[0-9a-f-]{36}/, '/:id') && l.route.methods[method]);
    const id = (url.match(/^\/([0-9a-f-]{36})/) || [])[1];
    const res = fakeRes();
    await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, params: { id }, body, auth: { name: 'Dana Ruiz' } }, res);
    return res;
  };
  return { pool, calls, call };
}
const DID = 'd0000000-0000-4000-8000-000000000001';

test('approve re-reads Google first and stands down a review somebody already answered', async () => {
  const w = routeWorld({ google: { answered: true } });
  const res = await w.call('post', `/${DID}/approve`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, "Someone already answered this review on Google, so I didn't post.");
  assert.equal(w.calls.fetched, 1);
  assert.equal(w.calls.posted.length, 0);
  assert.ok(w.pool.statements.some((x) => /UPDATE arion\.gbp_reply_draft/.test(x.text) && x.inputs.status === 'stood_down'));
});

test('approve never posts blind: Google unreadable → 503, nothing posted', async () => {
  const w = routeWorld({ google: { error: true } });
  const res = await w.call('post', `/${DID}/approve`);
  assert.equal(res.statusCode, 503);
  assert.equal(w.calls.posted.length, 0);
});

test('approve posts the reply and records the person', async () => {
  const w = routeWorld();
  const res = await w.call('post', `/${DID}/approve`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.calls.posted, [{ id: 'r1', text: 'Thank you!' }]);
  const move = w.pool.statements.find((x) => /UPDATE arion\.gbp_reply_draft/.test(x.text) && x.inputs.status === 'posted');
  assert.equal(move.inputs.by, 'Dana Ruiz');
});

test('approve with an edit runs the checks again; a fired check refuses with its sentence', async () => {
  const w = routeWorld();
  const res = await w.call('post', `/${DID}/approve`, { body: 'Sorry! Next visit is only $10.' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, HELD_WORDS.no_price);
  assert.equal(w.calls.posted.length, 0);
  const ok = await routeWorld().call('post', `/${DID}/approve`, { body: 'Sorry we were late. We will make it right.' });
  assert.equal(ok.statusCode, 200, 'a 2-star review approved by a person posts: the person IS the asking');
});

test('a Google refusal leaves the reply failed with its sentence (502)', async () => {
  const w = routeWorld({ google: { refuse: true } });
  const res = await w.call('post', `/${DID}/approve`);
  assert.equal(res.statusCode, 502);
  assert.ok(w.pool.statements.some((x) => x.inputs.status === 'failed'));
});

test('skip moves only a waiting reply', async () => {
  const w = routeWorld();
  const res = await w.call('post', `/${DID}/skip`, { reason: 'Not worth it' });
  assert.equal(res.statusCode, 200);
  const st = w.pool.statements.find((x) => /SET status = 'skipped'/.test(x.text));
  assert.match(st.text, /status IN \('held','failed'\)/);
  assert.equal(st.inputs.reason, 'Not worth it');
});

test('run now refuses when the job is off', async () => {
  const router = makeReviewRepliesRouter({ getPool: async () => recordingPool(), jobsOn: fakeJobsOn({}), tick: async () => { throw new Error('must not run'); } });
  const layer = router.stack.find((l) => l.route && l.route.path === '/run');
  const res = fakeRes();
  await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, 'Google review replies are off. Switch them on first.');
});

/* ══ 9. the dev fake for Google reviews ═════════════════════════════════ */

test('the review fake needs both locks; a set WEBSITE_SITE_NAME ignores the file', async () => {
  const file = path.join(os.tmpdir(), `gbp-fake-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ 'locations/x': { reviews: [{ reviewId: 'a', starRating: 2, comment: 'meh' }], replies: [] } }));
  try {
    assert.equal(fakeEnabled({ ARION_GBP_FAKE_FILE: file }), true);
    assert.equal(fakeEnabled({ ARION_GBP_FAKE_FILE: file, WEBSITE_SITE_NAME: 'arion-api-prod' }), false);
    assert.equal(fakeEnabled({}), false);
    assert.equal(reviewsApi({ ARION_GBP_FAKE_FILE: file, WEBSITE_SITE_NAME: 'arion-api-prod' }).fake, false);
    assert.equal(reviewsApi({ WEBSITE_SITE_NAME: 'arion-api-prod' }).readOnly, undefined, 'the live service posts');
    // A machine that is neither the live service nor using the fake never posts to Google.
    const devReal = reviewsApi({});
    assert.equal(devReal.readOnly, true);
    assert.match((await devReal.replyToReview('real-token', 'locations/x', 'r1', 'Thanks')).error, /only by the live service/);
    const api = reviewsApi({ ARION_GBP_FAKE_FILE: file });
    assert.equal(api.fake, true);
    assert.equal((await api.fetchReviews('t', 'locations/x')).reviews[0].replyComment, null);
    await api.replyToReview('t', 'locations/x', 'a', 'Thanks');
    assert.equal((await api.fetchReviews('t', 'locations/x')).reviews[0].replyComment, 'Thanks');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

/* ══ 10. Needs you rows ═════════════════════════════════════════════════ */

const contentRow = (over = {}) => ({
  output_id: 'o1', content_type: 'blog_post', primary_keyword: 'lawn', title: 'T', body_markdown: 'B',
  review_status: 'pending', decision_rule_flags_json: '[]', created_at: '2026-10-08T12:00:00Z',
  job_key: 'arion.blog_posts', brief_cited_json: JSON.stringify({ version: 7, saved_at: '2026-10-02T14:10:00Z', used: ['services'] }),
  ...over,
});

test('a pending blog post: job, employee, why it waited, its citation and its own routes', () => {
  const r = normaliseContentRow(contentRow());
  assert.equal(r.job_key, 'arion.blog_posts');
  assert.equal(r.employee_key, 'web');
  assert.equal(r.held_words, HELD_WORDS.send_me_first);
  assert.deepEqual(r.brief_cited, { version: 7, saved_at: '2026-10-02T14:10:00Z', used: ['services'] });
  assert.equal(r.decide.approve.path, '/arion/content-agent/queue/o1/approve');
  assert.equal(r.decide.approve.label, 'Approve');
  assert.deepEqual(r.decide.approve.edits, ['title', 'body']);
  assert.deepEqual(r.decide.skip, { path: '/arion/content-agent/queue/o1/reject', reason: 'optional' });
});

test('a pending social post asks for a time; an escalated one needs changed words', () => {
  const social = normaliseContentRow(contentRow({ content_type: 'social_post', job_key: 'arion.social_posts' }));
  assert.equal(social.decide.approve.label, 'Approve and schedule');
  assert.equal(social.decide.approve.when, 'schedule');
  const esc = normaliseContentRow(contentRow({ review_status: 'escalated', decision_rule_flags_json: JSON.stringify([{ rule: 'check:no_competitor_names' }]) }));
  assert.equal(esc.decide.approve.edits_required, true);
  assert.equal(esc.decide.approve.label, 'Change the words, then approve');
  assert.equal(esc.held_words, HELD_WORDS.no_competitor_names);
});

test('approved-not-published offers "Put it on your website"; a failed hand-off offers "Try again"', () => {
  const blog = normaliseContentRow(contentRow({ review_status: 'approved', approved_at: '2026-10-08T12:00:00Z' }));
  assert.deepEqual(blog.decide, { publish: { path: '/arion/content-agent/queue/o1/publish', label: 'Put it on your website' } });
  const social = normaliseContentRow(contentRow({ content_type: 'social_post', review_status: 'approved', handoff_error_plain: 'down' }));
  assert.equal(social.decide.approve.path, '/arion/content-agent/queue/o1/schedule');
  assert.equal(social.decide.approve.label, 'Try again');
  const done = normaliseContentRow(contentRow({ content_type: 'social_post', review_status: 'approved', scheduled_social_post_id: '42' }));
  assert.deepEqual(done.decide, {});
  assert.equal(isWaiting(done), false);
});

test('a held review reply and a failed one are cards; a posted one is not', () => {
  const held = normaliseReviewReplyRow({ draft_id: 'd1', star_rating: 2, reviewer_name: 'Sam', reply_text: 'Sorry', status: 'held', held_words: HELD_WORDS.low_star, created_at: '2026-10-08T12:00:00Z' });
  assert.equal(held.job_key, 'arion.review_replies');
  assert.equal(held.summary, 'Reply to a 2-star review from Sam');
  assert.equal(held.held_words, HELD_WORDS.low_star);
  assert.equal(held.decide.approve.label, 'Post this reply');
  assert.equal(held.decide.approve.path, '/arion/review-replies/d1/approve');
  const failed = normaliseReviewReplyRow({ draft_id: 'd2', star_rating: 5, reply_text: 'Thanks', status: 'failed' });
  assert.equal(failed.decide.approve.label, 'Try again');
  const posted = normaliseReviewReplyRow({ draft_id: 'd3', star_rating: 5, reply_text: 'Thanks', status: 'posted', decided_by: 'Approved in advance by X' });
  assert.deepEqual(posted.decide, {});
  assert.equal(isWaiting(posted), false);
});

test('?waiting=1 narrows in SQL and returns only rows with a button', async () => {
  const pool = recordingPool((text) => {
    if (/FROM arion\.content_agent_output/.test(text)) return [contentRow(), contentRow({ output_id: 'o2', review_status: 'rejected' })];
    if (/FROM arion\.gbp_reply_draft/.test(text)) return [{ draft_id: 'd1', star_rating: 2, reply_text: 'x', status: 'held' }];
    return null;
  });
  const out = await loadArionActivity(pool, T1, { waiting: true });
  assert.match(pool.statements.find((x) => /FROM arion\.content_agent_output/.test(x.text)).text, /review_status IN \('pending','escalated'\)/);
  assert.match(pool.statements.find((x) => /FROM arion\.gbp_reply_draft/.test(x.text)).text, /status IN \('held','failed'\)/);
  const all = [...out.rows, ...out.escalated];
  assert.deepEqual(all.map((r) => r.id).sort(), ['d1', 'o1']);
});

test('run rows carry job_key; review runs speak in sentences', () => {
  assert.equal(normaliseRunRow({ run_id: 'r', status: 'completed', job_key: 'arion.social_posts' }).job_key, 'arion.social_posts');
  const rr = normaliseReviewRunRow({ run_id: 'r', status: 'completed', outcome: 'worked', drafted: 2, held: 1, posted: 1, trigger_source: 'timer', notes_json: '[]' });
  assert.equal(rr.job_key, 'arion.review_replies');
  assert.equal(rr.outcome_label, 'Wrote 2 replies: posted 1 reply, 1 is waiting for you');
});

/* ══ 11. no file reads the moved switches (M15) ═════════════════════════ */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no code reads or writes the switches that moved to the jobs', () => {
  const files = ['lib', 'routes', 'workers', 'index.js'].flatMap((d) => {
    const p = path.join(ROOT, d);
    return fs.existsSync(p) ? (fs.statSync(p).isDirectory() ? walk(p) : [p]) : [];
  });
  const moved = /\b(gbp_auto_reply|gbp_auto_reply_min_stars|slots_per_cycle|content_types|protected_client_names_json|approved_client_names_json|competitor_names_json|shipped_features_json)\b/;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // The one allowed mention: the settings route's REFUSAL list, which names the
    // request fields it turns away (routes/arion/agents.js MOVED_FIELDS).
    const hit = src.split('\n').find((l) => moved.test(l) && !/const MOVED_FIELDS = Object\.freeze/.test(l));
    assert.equal(hit, undefined, `${path.relative(ROOT, f)} still names a moved switch: ${hit}`);
    // `enabled` and `brand_voice` are common words; refuse them only inside a
    // statement that names the content agent's old config table.
    for (const stmt of src.match(/`[^`]*content_agent_tenant_config[^`]*`/g) || []) {
      assert.doesNotMatch(stmt, /\benabled\b|\bbrand_voice\b/, `${path.relative(ROOT, f)}: ${stmt.slice(0, 120)}`);
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'lib', 'gbpAutoReplyRunner.js')), false, 'the old runner is deleted');
});

/* ══ 12. the defect test (§0.2) ═════════════════════════════════════════ */

const STREAM_FILES = [
  'db/migrations/069_review_replies_and_citations.sql', 'db/migrations/later/070_drop_moved_agent_switches.sql',
  'lib/jobChecks.js', 'lib/teamSeam.js', 'lib/businessTimeZone.js', 'lib/gbpReplyRunner.js', 'lib/gbpFake.js', 'lib/gbpAiReply.js',
  'lib/contentAgent/tick.js', 'lib/contentAgent/runner.js', 'lib/contentAgent/drafting.js',
  'lib/contentAgent/decisions.js', 'lib/contentAgent/socialHandoff.js',
  'lib/agents/activity.js', 'lib/agents/runs.js',
  'routes/internal.js', 'routes/arion/contentAgent.js', 'routes/arion/agents.js', 'routes/arion/reviewReplies.js',
  'scripts/dev/gbp-fake.mjs', 'scripts/dev/exercise-team-jobs.mjs',
];
// Pre-existing (finding F7), not this build's to fix; no new literal is added.
const PRE_EXISTING = ["export const ATTRIBUTION_ORG = 'Intelligent Analytics';"];
const DEFECT = [/Intelligent Analytics/i, /intelligentanalyticsdm/i, /ia-dm\.com/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /Web Design/, /Website audit/i, /walkthrough/i, /Des Moines/i];

test('no business\'s name, domain, id or words in the files this stream added or changed', () => {
  for (const f of STREAM_FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const text = f.endsWith('.sql') ? fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '') : stripComments(fs.readFileSync(p, 'utf8'));
    const lines = text.split('\n').filter((l) => !PRE_EXISTING.includes(l.trim()));
    for (const re of DEFECT) {
      const hit = lines.find((l) => re.test(l));
      assert.equal(hit, undefined, `${f}: ${re} in ${hit}`);
    }
  }
});

test('the words an owner reads from these runners never say tenant, agent, playbook, or a vendor', () => {
  const sentences = [...Object.values(HELD_WORDS), ...Object.values(RUN_WORDS).filter((v) => typeof v === 'string'), RUN_WORDS.unknownCheck('x'), RUN_WORDS.JOB_OFF('Blog posts')];
  for (const s of sentences) {
    assert.doesNotMatch(s, /\btenant\b|\bagent\b|playbook|guardrail|\bJSON\b|claude|anthropic|openai|haiku|sonnet/i, s);
  }
});
