// test/content-run-every-slot-failed.test.mjs — dev walk S12 (2026-10-08 15:57Z).
//
// ARGUS -> Your team -> The web person -> Jobs -> Blog posts -> Run it now,
// with two topics to lean towards: both pieces were tried and both failed (the
// provider call threw), yet the run row said 'completed' with no error, the
// only log line read like success, and the owner was told "It has had a look
// and there was nothing to do."
//
//   1. A run where EVERY attempt failed is a failed run: status 'failed', a
//      plain error_detail, attempted and failed counts on the result, and a
//      warn line with the rule and the reason code (the provider's text stays
//      in the log).
//   2. The tick's log line says the status and failed=N whenever N > 0.
//   3. Run it now answers that run as results[].status 'failed' (the Portal's
//      runResult turns that into RUN_FAILED_WORDS, never the no-work line).
//   4. Some failed, some written: completed, the failure counted and said.
//   5. A run that throws, and History: plain sentences, never driver text.
//
// Each test here goes red when its fix is taken out (mutations run by hand,
// named in the commit).

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCycle, RUN_FAIL_WORDS } from '../lib/contentAgent/runner.js';
import { runTick, runLogLine, STYLE_COMPILE_FAILED_WORDS } from '../lib/contentAgent/tick.js';
import { makeRunHandler } from '../routes/arion/agents.js';
import { normaliseRunRow, STOPPED_WORDS, FLAG_WORDS, flagSentence } from '../lib/agents/runs.js';
import { fakeJobsOn, fakeBriefFor, brief } from './helpers/team-job-fakes.mjs';

const T1 = 'a1111111-1111-4111-8111-111111111111';
const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });
const TOPICS = ['When to start mowing in spring', 'What to do about brown patches in a lawn'];
const KEY_TEXT = 'ANTHROPIC_API_KEY is not set';
const DRIVER = "RequestError: Invalid object name 'arion.content_agent_output'.";
// What an owner must never read: an exception's name, the provider's text, a
// reason code, a table, a setting's name.
const NOT_PLAIN = /Error|ANTHROPIC|API_KEY|is not set|provider_error|metered call|arion\.|Invalid object name|\w_\w|Run failed:/;

/** A pool that answers by query shape (an Error is thrown) and records every statement. */
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
          if (/SUM\(cost_usd\)/i.test(text)) return { recordset: [{ spent: 0 }] };
          if (/argus_action_pricing|action_pricing/i.test(text)) return { recordset: [{ credits_per_call: 0, outlier_cap_usd: 100, is_active: true }] };
          if (/OUTPUT INSERTED\.run_id/.test(text)) return { recordset: [{ run_id: `run-${statements.length}` }] };
          if (/OUTPUT INSERTED\.output_id/.test(text)) return { recordset: [{ output_id: `o-${statements.length}` }] };
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
/** console.warn/error/log captured (so a test can read the log), not printed. */
function capture(t) {
  const lines = [];
  for (const m of ['warn', 'error', 'log']) t.mock.method(console, m, (...a) => lines.push({ level: m, text: a.map(String).join(' ') }));
  return lines;
}

/** The model stand-in: a dull draft that places its keyword. */
function draftFor(userTurn) {
  const m = /PRIMARY KEYWORD:\s*(.+)/i.exec(String(userTurn));
  const kw = (m ? m[1] : 'lawn care tips').trim();
  const text = JSON.stringify({
    title: `${kw} basics`, meta_description: `A plain account of ${kw}.`, url_slug: 'lawn-care-tips',
    body_markdown: [`## About ${kw}`, '', `A note on ${kw} and how we approach it on every visit.`, '', '## More', '', 'Plain words.'].join('\n'),
    cover_image_prompt: 'A lawn.', confidence_note: 'Plain.',
  });
  return { inputTokens: 10, outputTokens: 10, imageCount: 0, data: { text, cacheReadTokens: 0 } };
}
/** The provider that failed on dev: it throws before any call. */
const throwing = async () => { throw new Error(KEY_TEXT); };
/** Fails the first topic, writes the second. */
const failsFirst = async ({ userTurn }) => {
  if (String(userTurn).includes(TOPICS[0])) throw new Error(KEY_TEXT);
  return draftFor(userTurn);
};

const research = async () => TOPICS.map((keyword) => ({ keyword, volume: 900, difficulty: 10, intent: 'informational' }));

function cycleArgs(pool, callImpl) {
  return { pool, tenantId: T1, slots: 2, triggerSource: 'manual', research, callImpl, jobKey: 'arion.blog_posts', checkNames: [], checkCtx: {} };
}
const closeOf = (pool) => pool.statements.find((s) => /UPDATE arion\.content_agent_run_log/.test(s.text));

/* ══ 1. every attempt failed: a failed run, in plain words ══════════════ */

test('a run where every piece failed is FAILED, with a plain error_detail, the counts, and a warn line with the rule and reason', async (t) => {
  const lines = capture(t);
  const pool = recordingPool();
  const res = await runCycle(cycleArgs(pool, throwing));

  assert.equal(res.status, 'failed', JSON.stringify(res));
  assert.equal(res.outcome, 'failed');
  assert.equal(res.drafted, 0);
  assert.equal(res.attempted, 2);
  assert.equal(res.failed, 2);

  const close = closeOf(pool);
  assert.ok(close, 'the run row was closed');
  assert.equal(close.inputs.status, 'failed', 'the run row says failed, never completed');
  assert.equal(close.inputs.err, RUN_FAIL_WORDS.allSlotsFailed(2));
  assert.doesNotMatch(close.inputs.err, NOT_PLAIN, close.inputs.err);
  assert.doesNotMatch(close.inputs.err, /nothing to do/i);

  // The alerts an owner's answer carries are plain too: the topic, never the provider's text.
  assert.equal(res.alerts.filter((a) => a.code === 'provider_error').length, 2, JSON.stringify(res.alerts));
  for (const a of res.alerts) assert.doesNotMatch(a.message, NOT_PLAIN, a.message);
  assert.equal(res.alerts[0].message, RUN_FAIL_WORDS.slotFailed(TOPICS[0]));

  // The log has the detail, at warn, with the rule and the reason code.
  const warn = lines.filter((l) => l.level === 'warn').map((l) => l.text);
  assert.ok(warn.some((w) => /rule=all_slots_failed/.test(w) && /status=failed/.test(w) && /failed=2/.test(w) && /reasons=provider_error,provider_error/.test(w)), warn.join('\n'));
  assert.ok(warn.some((w) => /rule=slot_skipped/.test(w) && /reason=provider_error/.test(w) && w.includes(KEY_TEXT)), warn.join('\n'));
});

test('the words for a failed run name no exception, key, code or vendor, and are not the no-work sentence', () => {
  for (const w of [RUN_FAIL_WORDS.allSlotsFailed(1), RUN_FAIL_WORDS.allSlotsFailed(2), RUN_FAIL_WORDS.someSlotsFailed(1, 2),
    RUN_FAIL_WORDS.slotFailed('x y'), RUN_FAIL_WORDS.stopped, RUN_FAIL_WORDS.costCeiling, RUN_FAIL_WORDS.rulesUnreadable,
    RUN_FAIL_WORDS.trackingFailed, STYLE_COMPILE_FAILED_WORDS, STOPPED_WORDS]) {
    assert.doesNotMatch(w, NOT_PLAIN, w);
    assert.doesNotMatch(w, /\btenant\b|\bagent\b|playbook|claude|anthropic|openai|ranking/i, w);
    assert.doesNotMatch(w, /nothing to do/i, w);
  }
  assert.equal(RUN_FAIL_WORDS.allSlotsFailed(1), "It tried to write a piece and couldn't write it this time, so nothing new is waiting for you. Try again later.");
});

/* ══ 2. the log line ════════════════════════════════════════════════════ */

test('the run\'s log line says the status and failed=N when anything failed (and stays as it was when nothing did)', () => {
  assert.equal(runLogLine(T1, 'arion.blog_posts', { status: 'failed', drafted: 0, escalated: 0, attempted: 2, failed: 2, costUsd: 0 }),
    `tenant ${T1} arion.blog_posts: failed drafted=0 escalated=0 attempted=2 failed=2 $0.0000`);
  assert.equal(runLogLine(T1, 'arion.blog_posts', { status: 'completed', drafted: 1, escalated: 0, attempted: 1, failed: 0, costUsd: 0.01 }),
    `tenant ${T1} arion.blog_posts: completed drafted=1 escalated=0 $0.0100`);
});

/** The tick, for one business, with the real runner and the given provider. */
function tickWorld({ callImpl, answer } = {}) {
  const logged = [];
  const pool = recordingPool(answer);
  const tick = (args) => runTick({
    ...args,
    log: (m) => { logged.push(m); args.log?.(m); },
    ownership: ALL_ON,
    briefFor: fakeBriefFor(brief({ services: ['Mowing'] })),
    doResearch: async () => ({ provider: 'none', capabilities: { provider: 'none' }, detail: 'test', rows: TOPICS.map((keyword) => ({ keyword, volume: 900, difficulty: 10, intent: 'informational' })) }),
    callImpl,
    notify: async () => [],
  });
  const jobsOn = fakeJobsOn({ [T1]: [['arion.blog_posts', { vars: { posts_per_week: 2, seed_topics: TOPICS } }]] });
  return { pool, tick, jobsOn, logged };
}

test('the tick logs the failed run with its status and failed=2, and the result carries the counts', async (t) => {
  capture(t);
  const w = tickWorld({ callImpl: throwing });
  const summary = await w.tick({ pool: w.pool, tenantFilter: T1, jobKeys: ['arion.blog_posts'], jobsOn: w.jobsOn, triggerSource: 'manual' });
  const line = w.logged.find((m) => /arion\.blog_posts: /.test(m));
  assert.ok(line, w.logged.join('\n'));
  assert.match(line, /: failed drafted=0 escalated=0 attempted=2 failed=2 \$/);
  const r = summary.results.find((x) => x.jobKey === 'arion.blog_posts');
  assert.equal(r.status, 'failed');
  assert.equal(r.attempted, 2);
  assert.equal(r.failed, 2);
});

/* ══ 3. Run it now ══════════════════════════════════════════════════════ */

test('Run it now answers a run whose every piece failed as a failed result with the counts, in plain words', async (t) => {
  const lines = capture(t);
  const w = tickWorld({ callImpl: throwing });
  const handler = makeRunHandler({ getPool: async () => w.pool, jobsOn: w.jobsOn, tick: w.tick });
  const res = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const results = res.body.data.results;
  assert.equal(results.length, 1, JSON.stringify(results));
  const [r] = results;
  // The Portal's runResult reads results[].status === 'failed' (or outcome
  // 'failed') and says RUN_FAILED_WORDS in rose; no words of our own here, so
  // it says exactly those.
  assert.equal(r.status, 'failed');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.drafted, 0);
  assert.equal(r.attempted, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.words, undefined);
  const body = JSON.stringify(res.body);
  assert.doesNotMatch(body, /ANTHROPIC|API_KEY|is not set|metered call|Error/, body);
  for (const a of res.body.data.alerts) assert.doesNotMatch(a.message, NOT_PLAIN, a.message);
  assert.ok(lines.some((l) => /\[content-agent:run\].*failed drafted=0 escalated=0 attempted=2 failed=2/.test(l.text)), 'the run route\'s log line says failed=2');
});

/* ══ 4. some failed, some written ═══════════════════════════════════════ */

test('a run where one piece failed and one was written is completed, with the failure counted and said', async (t) => {
  const lines = capture(t);
  const pool = recordingPool();
  const res = await runCycle(cycleArgs(pool, failsFirst));
  assert.equal(res.drafted, 1, JSON.stringify(res));
  assert.equal(res.attempted, 2);
  assert.equal(res.failed, 1);
  assert.ok(['completed', 'escalated'].includes(res.status), res.status);
  assert.equal(res.words, RUN_FAIL_WORDS.someSlotsFailed(1, 2));
  assert.equal(res.words, "1 of the 2 pieces it tried couldn't be written this time.");
  const close = closeOf(pool);
  assert.notEqual(close.inputs.status, 'failed');
  assert.equal(close.inputs.err, null);
  assert.ok(lines.some((l) => l.level === 'warn' && /rule=slot_skipped/.test(l.text) && /reason=provider_error/.test(l.text)));
  assert.ok(!lines.some((l) => /rule=all_slots_failed/.test(l.text)), 'a run that wrote something is not all-failed');

  // Through the tick and the route: the counts and the sentence ride on the result, and the log says failed=1.
  const w = tickWorld({ callImpl: failsFirst });
  const handler = makeRunHandler({ getPool: async () => w.pool, jobsOn: w.jobsOn, tick: w.tick });
  const out = fakeRes();
  await handler({ tenant: { tenantId: T1 }, body: { job_key: 'arion.blog_posts' } }, out);
  const [r] = out.body.data.results;
  assert.notEqual(r.status, 'failed');
  assert.equal(r.drafted, 1);
  assert.equal(r.attempted, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.words, RUN_FAIL_WORDS.someSlotsFailed(1, 2));
  assert.ok(w.logged.some((m) => /drafted=1 escalated=\d attempted=2 failed=1 \$/.test(m)), w.logged.join('\n'));
});

/* ══ 5. a run that throws, and History ══════════════════════════════════ */

test('a run that throws records a plain error_detail and a plain alert; the exception goes to the log', async (t) => {
  const lines = capture(t);
  const pool = recordingPool((text) => (/INSERT INTO arion\.content_agent_output/.test(text) || /OUTPUT INSERTED\.output_id/.test(text) ? new Error(DRIVER) : null));
  const res = await runCycle(cycleArgs(pool, async ({ userTurn }) => draftFor(userTurn)));
  assert.equal(res.status, 'failed', JSON.stringify(res));
  const close = pool.statements.find((s) => /UPDATE arion\.content_agent_run_log/.test(s.text) && s.inputs.status === 'failed');
  assert.ok(close);
  assert.equal(close.inputs.err, RUN_FAIL_WORDS.stopped);
  const alert = res.alerts.find((a) => a.failure_mode === 'F2');
  assert.equal(alert.message, RUN_FAIL_WORDS.stopped);
  for (const a of res.alerts) assert.doesNotMatch(a.message, NOT_PLAIN, a.message);
  assert.ok(lines.some((l) => l.level === 'warn' && /rule=run_failed/.test(l.text) && l.text.includes(DRIVER)), 'the driver text is in the log');
});

test('rules that cannot be read and a learning step that fails are said plainly; the driver text goes to the log', async (t) => {
  const lines = capture(t);
  const w = tickWorld({
    callImpl: async ({ userTurn }) => draftFor(userTurn),
    answer: (text) => (/argus\.governance_rule|content_agent_style_signal/.test(text) ? new Error(DRIVER) : null),
  });
  const summary = await w.tick({ pool: w.pool, tenantFilter: T1, jobKeys: ['arion.blog_posts'], jobsOn: w.jobsOn, triggerSource: 'manual' });
  const rules = summary.alerts.find((a) => a.code === 'governance_rules_unavailable');
  const style = summary.alerts.find((a) => a.code === 'style_compile_failed');
  assert.ok(rules && style, JSON.stringify(summary.alerts));
  assert.equal(rules.message, RUN_FAIL_WORDS.rulesUnreadable);
  assert.equal(style.message, STYLE_COMPILE_FAILED_WORDS);
  for (const a of summary.alerts) assert.doesNotMatch(String(a.message), NOT_PLAIN, a.message);
  const flags = w.pool.statements.filter((s) => /UPDATE arion\.content_agent_run_log/.test(s.text)).map((s) => s.inputs.flags).join('');
  assert.doesNotMatch(flags, /RequestError|Invalid object name/, flags);
  assert.ok(lines.some((l) => l.level === 'warn' && /rule=governance_rules_unavailable/.test(l.text) && l.text.includes(DRIVER)));
  assert.ok(lines.some((l) => l.level === 'warn' && /rule=style_compile_failed/.test(l.text) && l.text.includes(DRIVER)));
});

test('History shows a failed run as failed, with the plain sentence; an older row\'s driver text is never the reason', (t) => {
  capture(t);
  const base = { run_id: 'r1', trigger_source: 'manual', triggered_at: '2026-10-08T15:57:00Z', completed_at: '2026-10-08T15:57:05Z', job_key: 'arion.blog_posts', drafted: 0, keywords: null };
  const failedRow = normaliseRunRow({
    ...base, status: 'failed', error_detail: RUN_FAIL_WORDS.allSlotsFailed(2),
    decision_rule_flags_json: JSON.stringify([{ rule: 'slot_skipped', keyword: TOPICS[0], detail: 'provider_error' }, { rule: 'slot_skipped', keyword: TOPICS[1], detail: 'provider_error' }]),
  });
  assert.equal(failedRow.outcome, 'failed');
  assert.equal(failedRow.status, 'failed');
  assert.equal(failedRow.failure.reason, RUN_FAIL_WORDS.allSlotsFailed(2));
  assert.doesNotMatch(failedRow.outcome_label, /nothing to do/i);

  for (const old of [
    "RequestError: Invalid object name 'arion.content_agent_output'.",
    `DraftingError: metered call failed: provider_error | ${KEY_TEXT}`,
    'Error: getaddrinfo ENOTFOUND sql-x:1433',
    'Run failed: SE Ranking answered 500.',
  ]) {
    const row = normaliseRunRow({ ...base, status: 'failed', error_detail: old, decision_rule_flags_json: '[]' });
    assert.equal(row.failure.reason, STOPPED_WORDS, old);
  }

  // A flag the History panel has no words for never shows its raw detail when that detail is driver text.
  assert.equal(flagSentence({ rule: 'keyword_tracking_failed', detail: DRIVER }), FLAG_WORDS.keyword_tracking_failed);
  assert.doesNotMatch(flagSentence({ rule: 'something_new', detail: DRIVER }), /RequestError|Invalid object name/);
  assert.equal(flagSentence({ rule: 'keywords_tracked', detail: '2 topics recorded' }), '2 topics recorded');
});

test('a business whose tick throws gets a plain sentence on its result; the exception goes to the log', async (t) => {
  const lines = capture(t);
  const w = tickWorld({ callImpl: throwing });
  const summary = await runTick({
    pool: w.pool, log: () => {}, tenantFilter: T1, jobKeys: ['arion.blog_posts'], jobsOn: w.jobsOn, ownership: ALL_ON,
    briefFor: fakeBriefFor(brief({ services: ['Mowing'] })), notify: async () => [],
    doResearch: async () => { throw new Error(DRIVER); },
  });
  const r = summary.results.find((x) => x.status === 'tick_error');
  assert.ok(r, JSON.stringify(summary.results));
  assert.equal(r.words, RUN_FAIL_WORDS.stopped);
  assert.doesNotMatch(JSON.stringify(r), /RequestError|Invalid object name/, JSON.stringify(r));
  assert.ok(lines.some((l) => l.level === 'warn' && /rule=tick_error/.test(l.text) && l.text.includes(DRIVER)));
});
