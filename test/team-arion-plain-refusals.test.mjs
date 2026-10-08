// test/team-arion-plain-refusals.test.mjs — an owner never reads a check's
// key or an exception.
//
//   1. The three places that refuse a check this job can't run (approving an
//      escalated draft, the content run, an edited review reply) say it with
//      RUN_WORDS.unknownCheck, the check's own plain words. Putting any of them
//      back to 'ARGUS has no check called ' + key turns its test red.
//   2. The four Settings -> Agents reads and writes answer SERVER_WORDS when the
//      store throws, and the lists name a source they could not read in plain
//      words: driver text ("RequestError: Invalid object name ...") goes to the
//      log, never into a body.

import test from 'node:test';
import assert from 'node:assert/strict';

import { RUN_WORDS } from '../lib/jobChecks.js';
import { recheck, approveOutput, DecisionRefused } from '../lib/contentAgent/decisions.js';
import { runCycle } from '../lib/contentAgent/runner.js';
import { makeReviewRepliesRouter, EDIT_CHECKS } from '../routes/arion/reviewReplies.js';
import { makeAgentsRouter, SERVER_WORDS } from '../routes/arion/agents.js';
import { DEGRADED_WORDS } from '../lib/agents/activity.js';
import { fakeJobsOn, fakeBriefFor, brief } from './helpers/team-job-fakes.mjs';

const T1 = 'a1111111-1111-4111-8111-111111111111';
// A check in the library's words that no web-person job can run.
const KEY = 'over_money_limit_asks';
const PLAIN = 'This job can\'t run its check "Never send a quote over your limit without you", so I did nothing.';
const DRIVER = 'RequestError: Invalid object name \'arion.content_agent_tenant_config\'.';

function assertPlain(words) {
  assert.equal(words, PLAIN);
  assert.equal(words, RUN_WORDS.unknownCheck(KEY));
  assert.ok(!String(words).includes(KEY), `the raw key reached the owner: ${words}`);
  assert.doesNotMatch(String(words), /has no check called|ARGUS/);
}

/** A pool that answers by query shape (null = empty) and records every statement. */
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
const quietly = async (t, fn) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  return fn();
};

/* ══ 1. a check this job can't run, in plain words ═════════════════════ */

test('recheck (approving an escalated draft) names a check it cannot run in plain words, never its key', () => {
  assertPlain(recheck('A plain draft.', { jobKey: 'arion.blog_posts', checkCtx: {}, names: ['no_price', KEY] }));
});

test('approving an escalated draft whose job added a check it cannot run refuses 409 in plain words', async () => {
  const pool = recordingPool((text) => (/FROM arion\.content_agent_output/.test(text) && /SELECT/.test(text)
    ? [{ output_id: 'o1', content_type: 'blog_post', job_key: 'arion.blog_posts', title: 'T', body_markdown: 'B',
      meta_description: 'M', review_status: 'escalated', decision_rule_flags_json: JSON.stringify([{ rule: 'check:no_price' }]),
      checks_json: JSON.stringify(['no_price', KEY]) }]
    : null));
  await assert.rejects(
    () => approveOutput(pool, {
      tenantId: T1, outputId: 'o1', actor: 'Dana', edits: { body_markdown: 'A plainer draft.' },
      loadCheckCtx: async () => ({ approvedOffers: [], approvedProof: [], namesNeverMention: [], namesYouMayMention: [], competitors: [] }),
      signal: async () => {},
    }),
    (e) => { assert.ok(e instanceof DecisionRefused); assert.equal(e.status, 409); assertPlain(e.message); return true; },
  );
  assert.equal(pool.statements.filter((s) => /UPDATE arion\.content_agent_output/.test(s.text)).length, 0, 'nothing was approved');
});

/** The content run's pool: one cycle, a free metered action, a run row. */
function runPool() {
  return recordingPool((text) => {
    if (/SUM\(cost_usd\)/i.test(text)) return [{ spent: 0 }];
    if (/argus_action_pricing/i.test(text)) return [{ credits_per_call: 0, outlier_cap_usd: 100, is_active: true }];
    if (/INSERT INTO arion\.content_agent_run_log/i.test(text)) return [{ run_id: 'run-1' }];
    if (/OUTPUT INSERTED\.output_id/i.test(text)) return [{ output_id: 'out-1' }];
    return null;
  });
}
/** The model stand-in (the runner's callImpl seam): a dull draft that places its keyword. */
function standIn({ userTurn = '' } = {}) {
  const m = /PRIMARY KEYWORD:\s*(.+)/i.exec(String(userTurn));
  const kw = (m ? m[1] : 'lawn care tips').trim();
  const text = JSON.stringify({
    title: `${kw} basics`, meta_description: `A plain account of ${kw}.`, url_slug: 'lawn-care-tips',
    body_markdown: [`## About ${kw}`, '', `A note on ${kw} and how we approach it on every visit.`, '', '## More', '', 'Plain words.'].join('\n'),
    cover_image_prompt: 'A lawn.', confidence_note: 'Plain.',
  });
  return { inputTokens: 10, outputTokens: 10, imageCount: 0, data: { text, cacheReadTokens: 0 } };
}

test('a content run that meets a check it cannot run fails, and says so in plain words (alert and run row)', async (t) => {
  const pool = runPool();
  const res = await quietly(t, () => runCycle({
    pool, tenantId: T1, slots: 1, triggerSource: 'manual',
    research: async () => [{ keyword: 'lawn care tips', volume: 900, difficulty: 10, intent: 'informational' }],
    callImpl: standIn, jobKey: 'arion.blog_posts', checkNames: ['no_price', KEY], checkCtx: {},
  }));
  assert.equal(res.status, 'failed');
  assert.equal(res.drafted, 0, 'nothing was queued');
  const alert = res.alerts.find((a) => a.code === 'unknown_check');
  assert.ok(alert, JSON.stringify(res.alerts));
  assert.ok(alert.message.includes(PLAIN), alert.message);
  assert.ok(!alert.message.includes(KEY), alert.message);
  assert.doesNotMatch(alert.message, /has no check called|ARGUS/);
  const closed = pool.statements.find((s) => /UPDATE arion\.content_agent_run_log/.test(s.text) && s.inputs.status === 'failed');
  assert.ok(closed, 'the run row was closed failed');
  assert.ok(String(closed.inputs.err).includes(PLAIN), closed.inputs.err);
  assert.ok(!String(closed.inputs.err).includes(KEY), closed.inputs.err);
});

test('an edited review reply whose checks hold one this runner cannot run is refused 409 in plain words, nothing posted', async () => {
  const posted = [];
  const pool = recordingPool((text) => {
    if (/FROM arion\.gbp_reply_draft d\s+JOIN arion\.site/.test(text)) {
      return [{ draft_id: 'd1', site_id: 's1', gbp_review_id: 'r1', reply_text: 'Thank you!', star_rating: 5, review_text: 'Great.', status: 'held', gbp_oauth_token_ref: 'ref', gbp_location_name: 'loc' }];
    }
    if (/SET status = 'posting'/.test(text)) return [{ affected: 1 }];
    return null;
  });
  const api = () => ({
    fetchReviews: async () => ({ reviews: [{ reviewId: 'r1', replyComment: null }] }),
    replyToReview: async (_t, _l, id, text) => { posted.push({ id, text }); return { reply: {} }; },
  });
  const router = makeReviewRepliesRouter({
    getPool: async () => pool, api, briefFor: fakeBriefFor(brief({})), jobsOn: fakeJobsOn({ [T1]: ['arion.review_replies'] }),
    tick: async () => ({}), editChecks: [...EDIT_CHECKS, KEY],
  });
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id/approve');
  const res = fakeRes();
  await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, params: { id: 'd0000000-0000-4000-8000-000000000001' }, body: { body: 'Thanks so much, see you in spring.' }, auth: { name: 'Dana Ruiz' } }, res);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'UNKNOWN_CHECK');
  assertPlain(res.body.error.message);
  assert.equal(posted.length, 0, 'nothing reached Google');
  assert.equal(pool.statements.filter((s) => /SET status = 'posting'/.test(s.text)).length, 0, 'nothing was claimed');
});

/* ══ 2. a store that throws never reaches the body ═════════════════════ */

const ROUTES = [
  ['get', '/activity', {}],
  ['get', '/runs', {}],
  ['get', '/settings', {}],
  ['put', '/settings', { content: { paused: false } }],
];

async function call(router, method, path, body) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path} is routed`);
  const res = fakeRes();
  await layer.route.stack[0].handle({ tenant: { tenantId: T1 }, query: {}, body, params: {} }, res);
  return res;
}

test('a pool that cannot be had: every Settings -> Agents route answers 500 in plain words, no driver text', async (t) => {
  const router = makeAgentsRouter({ getPool: async () => { throw new Error(`ConnectionError: Failed to connect to localhost:1433 - ${DRIVER}`); } });
  await quietly(t, async () => {
    for (const [method, path, body] of ROUTES) {
      const res = await call(router, method, path, body);
      assert.equal(res.statusCode, 500, `${method} ${path}`);
      assert.equal(res.body.error.message, SERVER_WORDS, `${method} ${path}`);
      assert.doesNotMatch(JSON.stringify(res.body), /RequestError|ConnectionError|Invalid object name|1433/, `${method} ${path}`);
    }
  });
});

test('a store whose every query throws: settings answer 500 in plain words, the lists say a part could not be read, no driver text', async (t) => {
  const pool = recordingPool(() => new Error(DRIVER));
  const router = makeAgentsRouter({ getPool: async () => pool });
  await quietly(t, async () => {
    for (const [method, path, body] of ROUTES) {
      const res = await call(router, method, path, body);
      const text = JSON.stringify(res.body);
      assert.doesNotMatch(text, /RequestError|Invalid object name|arion\.content_agent/, `${method} ${path}: ${text}`);
      if (path === '/settings') {
        assert.equal(res.statusCode, 500, `${method} ${path}`);
        assert.equal(res.body.error.message, SERVER_WORDS, `${method} ${path}`);
      } else {
        assert.equal(res.statusCode, 200, `${method} ${path}`);
        const degraded = res.body.data.meta.degraded;
        assert.ok(degraded.length > 0, `${path} says what it could not read`);
        for (const d of degraded) assert.equal(d.error, DEGRADED_WORDS.unreadable, `${path}`);
      }
    }
  });
});

test('a list whose source table is missing says so in plain words, never the table name', async (t) => {
  // tableExists answers "no" (an empty recordset) for every source.
  const router = makeAgentsRouter({ getPool: async () => recordingPool(() => null) });
  await quietly(t, async () => {
    for (const path of ['/activity', '/runs']) {
      const res = await call(router, 'get', path, {});
      assert.equal(res.statusCode, 200);
      const degraded = res.body.data.meta.degraded;
      assert.ok(degraded.length > 0, path);
      for (const d of degraded) assert.equal(d.error, DEGRADED_WORDS.missing, path);
      assert.doesNotMatch(JSON.stringify(res.body), /arion\.|not in this database/, path);
    }
  });
});

test('the plain words themselves name no key, no table and no exception', () => {
  for (const w of [SERVER_WORDS, ...Object.values(DEGRADED_WORDS), PLAIN]) {
    assert.doesNotMatch(w, /[a-z]+_[a-z]+|arion\.|Error|agent|tenant/i, w);
  }
});
