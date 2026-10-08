// test/content-run-alert-words.test.mjs — round-3 verifier R3 (2026-10-08 16:16Z).
//
// What an owner reads in a run's alerts is a plain sentence, never the
// renderer's exception text and never a list of rule codes:
//
//   1. a carousel whose slides could not be made: the topic and what to do,
//      the renderer's text only in the warn log;
//   2. a piece kept back by one of its rules: the topic and that it waits to
//      be read, the rule codes only in the warn log;
//   3. an approval in advance that did not go through: the plain sentence,
//      the exception only in the warn log.
//
// Each test goes red when its fix is taken out (mutations run by hand, named
// in the commit).

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCycle, sendInAdvance, RUN_FAIL_WORDS } from '../lib/contentAgent/runner.js';

const T1 = 'a1111111-1111-4111-8111-111111111111';
const TOPIC = 'When to start mowing in spring';
const RENDER_TEXT = 'Error: Failed to launch the browser process! spawn /opt/render/chrome ENOENT';
const DRIVER = "RequestError: Invalid object name 'arion.content_agent_output'.";
// What an owner must never read: an exception's name or text, a reason or rule
// code, a table, the old "tripped an escalation rule" wording.
const NOT_PLAIN = /Error|ENOENT|browser process|arion\.|Invalid object name|\w_\w|check:|escalation rule|Content unit|Carousel/;

/** A pool that answers by query shape and records every statement. */
function recordingPool() {
  const statements = [];
  return {
    statements,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query(text) {
          statements.push({ text, inputs: { ...inputs } });
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
/** console.warn/error/log captured (so a test can read the log), not printed. */
function capture(t) {
  const lines = [];
  for (const m of ['warn', 'error', 'log']) t.mock.method(console, m, (...a) => lines.push({ level: m, text: a.map(String).join(' ') }));
  return lines;
}

/** The model stand-in: a dull draft that places its keyword, with `extra` in its body. */
const drafter = (extra = '') => async ({ userTurn }) => {
  const m = /PRIMARY KEYWORD:\s*(.+)/i.exec(String(userTurn));
  const kw = (m ? m[1] : 'lawn care tips').trim();
  const text = JSON.stringify({
    title: `${kw} basics`, meta_description: `A plain account of ${kw}.`, url_slug: 'lawn-care-tips',
    body_markdown: [`## About ${kw}`, '', `A note on ${kw} and how we approach it on every visit.`, '', '## More', '', `Plain words.${extra}`].join('\n'),
    slides: [{ heading: kw, body: 'One.' }, { heading: 'Two', body: 'Two.' }, { heading: 'Book', body: 'Three.' }],
    cover_image_prompt: 'A lawn.', confidence_note: 'Plain.',
  });
  return { inputTokens: 10, outputTokens: 10, imageCount: 0, data: { text, cacheReadTokens: 0 } };
};
const research = async () => [{ keyword: TOPIC, volume: 900, difficulty: 10, intent: 'informational' }];

test('a carousel whose slides could not be made: a plain alert with the topic; the renderer\'s text only in the warn log', async (t) => {
  const lines = capture(t);
  const res = await runCycle({
    pool: recordingPool(), tenantId: T1, slots: 1, triggerSource: 'manual', research,
    contentType: 'social_carousel', callImpl: drafter(),
    render: async () => { throw Object.assign(new Error(RENDER_TEXT), { code: 'render_failed' }); },
  });
  const alert = (res.alerts || []).find((a) => a.failure_mode === 'F7');
  assert.ok(alert, JSON.stringify(res));
  assert.equal(alert.message, RUN_FAIL_WORDS.renderFailed(TOPIC));
  assert.doesNotMatch(alert.message, NOT_PLAIN, alert.message);
  assert.ok(alert.message.includes(TOPIC));
  const warn = lines.filter((l) => l.level === 'warn').map((l) => l.text).find((l) => /rule=render_failed/.test(l));
  assert.ok(warn, 'the log has the render failure at warn');
  assert.ok(warn.includes(RENDER_TEXT), 'the renderer\'s own text stays in the log');
});

test('a piece kept back by one of its rules: a plain alert with the topic; the rule codes only in the warn log', async (t) => {
  const lines = capture(t);
  const res = await runCycle({
    pool: recordingPool(), tenantId: T1, slots: 1, triggerSource: 'manual', research,
    callImpl: drafter(' Mowing from $49 a visit.'), jobKey: 'arion.blog_posts', checkNames: ['no_price'], checkCtx: {},
  });
  const alert = (res.alerts || []).find((a) => a.code === 'escalation');
  assert.ok(alert, JSON.stringify(res));
  assert.equal(alert.immediate, true);
  assert.equal(alert.message, RUN_FAIL_WORDS.held(TOPIC));
  assert.doesNotMatch(alert.message, NOT_PLAIN, alert.message);
  const warn = lines.filter((l) => l.level === 'warn').map((l) => l.text).find((l) => /rule=escalated/.test(l));
  assert.ok(warn, 'the log has the hold at warn');
  assert.ok(warn.includes('check:no_price'), 'the rule codes stay in the log');
});

test('an approval in advance that did not go through: the plain sentence; the exception only in the warn log', async (t) => {
  const lines = capture(t);
  const sent = await sendInAdvance(recordingPool(), {
    tenantId: T1, outputId: 'o1', contentType: 'blog_post', automaticBy: 'Approved in advance by Dana',
    doors: {
      approve: async () => { throw new Error(DRIVER); },
      publish: async () => ({ ok: true }), handoff: async () => ({ ok: true }),
      timeZone: async () => 'America/Chicago', nextDayAt: () => '2026-10-09T15:00:00.000Z',
      markHeld: async () => {},
    },
  });
  assert.equal(sent.approved, false);
  assert.equal(sent.alerts.length, 1);
  assert.equal(sent.alerts[0].message, RUN_FAIL_WORDS.automaticFailed);
  assert.doesNotMatch(sent.alerts[0].message, NOT_PLAIN, sent.alerts[0].message);
  const warn = lines.filter((l) => l.level === 'warn').map((l) => l.text).find((l) => /rule=automatic_failed/.test(l));
  assert.ok(warn && warn.includes(DRIVER), 'the exception stays in the log');
});
