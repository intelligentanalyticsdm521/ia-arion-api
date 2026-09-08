// test/content-agent-alerts-gate.test.js
//
// Where the agent's alerts go, and the two seams they are not allowed to
// reinvent on the way out.
//
//   THE GATE   Every message asks platform-api's ONE preference gate, with a
//              category_key, before it is sent. A gate that cannot decide is a
//              HOLD, never a send: on the other side of a wrong answer is a
//              message arriving at somebody who asked us to stop.
//   THE NAME   Every business name comes from the ONE business identity. Not
//              `tenant.name || domain || tenantId`, not a literal. Eleven such
//              chains were deleted from this platform in September; an alert
//              subject line is not the place to start a twelfth.
//
// The alerts themselves were already being produced before this file existed —
// F3 escalation, F5 publish failure, F7 render failure, F8 cost halt, MARGIN
// breach — and they went nowhere but a Function App log. "Alert Brandon" in the
// failure table means a message, so these tests pin the message.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALERT_CATEGORY, OUTCOME, alertRecipient, renderAlertEmail,
  notifyTenantAlerts, notifyAlerts,
} from '../lib/contentAgent/alerts.js';
import { GateUnavailable } from '../lib/notificationGate.js';

const TENANT_A = 'a0000001-0000-0000-0000-000000000001';
const TENANT_B = 'b0000002-0000-0000-0000-000000000002';
const ENV = { CONTENT_AGENT_ALERT_EMAIL: 'founder@example.invalid' };

const ALERT = { failure_mode: 'F3', code: 'escalation', message: 'A unit tripped an escalation rule and was withheld.' };

function spies({ allowed = true, throwGate = null, name = 'Harbor Point Coffee', sendThrows = null } = {}) {
  const s = { gateCalls: [], nameCalls: [], sent: [] };
  s.gate = async (opts) => { s.gateCalls.push(opts); if (throwGate) throw throwGate; return { allowed, reason: allowed ? null : 'category_opt_out:owner_alerts_email' }; };
  s.resolveName = async (t) => { s.nameCalls.push(t); return name; };
  s.send = async (msg) => { if (sendThrows) throw new Error(sendThrows); s.sent.push(msg); return { ok: true }; };
  return s;
}

test('the category is the one canonical owner-facing key', () => {
  // platform-api lib/notificationGate.js CANONICAL_CATEGORY_KEYS. owner_alerts is
  // the key that addresses the business owner rather than their customer, and it
  // is deliberately not seeded as a customer-facing category.
  assert.equal(ALERT_CATEGORY, 'owner_alerts');
});

test('the gate is asked BEFORE anything is sent, with the category', async () => {
  const s = spies();
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: ENV, ...s });
  assert.equal(r.outcome, OUTCOME.SENT);
  assert.equal(s.gateCalls.length, 1);
  assert.deepEqual(s.gateCalls[0], {
    tenantId: TENANT_A, channel: 'email', to: 'founder@example.invalid', categoryKey: 'owner_alerts',
  });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].metadata.category_key, 'owner_alerts');
});

test('a gate that cannot decide HOLDS the alert — nothing is sent', async () => {
  const s = spies({ throwGate: new GateUnavailable('gate_unreachable', 'ECONNREFUSED') });
  const logs = [];
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: ENV, log: (m) => logs.push(m), ...s });
  assert.equal(r.outcome, OUTCOME.HELD);
  assert.equal(r.reason, 'gate_unreachable');
  assert.equal(r.count, 1, 'the held alert is still counted, so it is late and not lost');
  assert.equal(s.sent.length, 0, 'an undecidable gate must never fall through to sending');
  assert.equal(s.nameCalls.length, 0, 'nothing downstream of the gate should have run');
  assert.ok(logs.some((m) => /HELD/.test(m)));
});

test('a preference refusal is honoured and reported, not retried around', async () => {
  const s = spies({ allowed: false });
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: ENV, ...s });
  assert.equal(r.outcome, OUTCOME.SUPPRESSED);
  assert.match(r.reason, /owner_alerts/);
  assert.equal(s.sent.length, 0);
});

test('the business name comes from the resolver, never from the alert or a literal', async () => {
  const s = spies({ name: 'Summit Lawn & Landscape' });
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: ENV, ...s });
  assert.deepEqual(s.nameCalls, [TENANT_A], 'the one identity is asked, once, for this tenant');
  assert.equal(r.businessName, 'Summit Lawn & Landscape');
  assert.match(s.sent[0].subject, /Summit Lawn & Landscape/);
  assert.match(s.sent[0].html, /Summit Lawn &amp; Landscape/, 'the name is escaped into the html');
  assert.ok(!s.sent[0].subject.includes(TENANT_A), 'a GUID in a subject line is not a business name');
});

test('alerts.js resolves names through the one client and holds no chain of its own', () => {
  const src = fs.readFileSync('lib/contentAgent/alerts.js', 'utf8');
  assert.match(src, /from '\.\.\/businessIdentityClient\.js'/, 'the name must come from the one client');
  assert.match(src, /from '\.\.\/notificationGate\.js'/, 'the permission must come from the one gate');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/tenant_name|tenantName\s*\|\||\.domain\s*\|\|/.test(code),
    'a `||` over name-ish fields here is the start of the next name chain');
  assert.ok(!/Intelligent Analytics|Your Service Provider/.test(code),
    'no business name literal belongs in this file — the resolver owns the fallback');
});

test('no recipient configured is a loud skip, never a guessed address', async () => {
  const s = spies();
  const logs = [];
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: {}, log: (m) => logs.push(m), ...s });
  assert.equal(r.outcome, OUTCOME.NO_RECIPIENT);
  assert.equal(s.gateCalls.length, 0);
  assert.equal(s.sent.length, 0);
  assert.ok(logs.some((m) => /CONTENT_AGENT_ALERT_EMAIL/.test(m)), 'the log has to name the missing setting');
  assert.equal(alertRecipient({}), null);
  assert.equal(alertRecipient({ SITE_REQUEST_NOTIFY_EMAIL: 'x@y.invalid' }), 'x@y.invalid',
    'the founder inbox this repo already knows is the documented fallback');
});

test('a failed send never throws and never claims success', async () => {
  const s = spies({ sendThrows: 'postmark 500' });
  const r = await notifyTenantAlerts({ tenantId: TENANT_A, alerts: [ALERT], env: ENV, ...s });
  assert.equal(r.outcome, OUTCOME.SEND_FAILED);
  assert.match(r.reason, /postmark 500/);
});

test('one message per business — two tenants never share an envelope', async () => {
  const s = spies();
  const results = await notifyAlerts({
    alerts: [
      { tenantId: TENANT_A, ...ALERT },
      { tenantId: TENANT_B, failure_mode: 'MARGIN', code: 'cost_exceeds_60pct_of_price', message: 'over the line' },
      { tenantId: TENANT_A, failure_mode: 'F8', code: 'cost_ceiling', message: 'halted' },
    ],
    env: ENV, ...s,
  });
  assert.equal(results.length, 2);
  assert.equal(s.sent.length, 2);
  const forA = s.sent.find((m) => m.metadata.tenant_id === TENANT_A);
  const forB = s.sent.find((m) => m.metadata.tenant_id === TENANT_B);
  assert.equal(forA.metadata.failure_modes, 'F3,F8');
  assert.equal(forB.metadata.failure_modes, 'MARGIN');
  assert.ok(!forB.html.includes('escalation'), "one client's content must not appear in another's alert");
});

test('the email says nothing was published — the whole point of the queue', () => {
  const { html, text } = renderAlertEmail({ businessName: 'Bluebird Dental', alerts: [ALERT] });
  for (const body of [html, text]) {
    assert.match(body, /Nothing here has been published/);
  }
});

test('the tick dispatches its alerts and records the outcome in the summary', async () => {
  const { runTick } = await import('../lib/contentAgent/tick.js');
  const pool = {
    request: () => ({ input() { return this; }, async query() { return { recordset: [] }; } }),
  };
  const calls = [];
  const summary = await runTick({
    pool, env: {},
    notify: async ({ alerts }) => { calls.push(alerts); return [{ tenantId: TENANT_A, outcome: OUTCOME.SENT, count: 1 }]; },
  });
  assert.equal(calls.length, 1, 'the tick must hand its alerts to the notifier exactly once');
  assert.deepEqual(summary.notifications, [{ tenantId: TENANT_A, outcome: OUTCOME.SENT, count: 1 }]);
});
