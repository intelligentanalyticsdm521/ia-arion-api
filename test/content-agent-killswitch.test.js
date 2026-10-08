// test/content-agent-killswitch.test.js
//
// Scope 35 — the rollback plan is one environment variable.
//
// CONTENT_AGENT_DISABLED has to stop the agent, not merely stop the timer that
// normally starts it. The arion-func timer checks it and returns early; that is
// necessary and not sufficient, because /internal/content-agent-tick can be
// POSTed by hand, by a retry, or by a second scheduler somebody adds later. So
// the switch is also honoured inside runTick, BEFORE the config table is read.
//
// "Nothing was queued" is asserted the only way it can honestly be asserted:
// the fake pool records every statement it is asked to run, and the count has to
// be zero. A summary that says ran:0 proves nothing on its own — the swallow-and-
// report-success defect looks exactly like that.
//
// MUTATION-TESTED: removing the isContentAgentDisabled() guard from runTick, and
// separately narrowing it back to `=== 'true'`, each turn this file red.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isContentAgentDisabled, KILL_SWITCH_ENV } from '../lib/contentAgent/config.js';
import { runTick } from '../lib/contentAgent/tick.js';

// Every business here has ARION on; the product check has its own tests
// (test/product-ownership.test.mjs). Without this the tick would open the real
// platform pool to ask.
const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });

/** A pool that refuses to be used quietly: every query is recorded. */
function recordingPool(recordset = []) {
  const pool = { queries: [] };
  pool.request = () => ({
    input() { return this; },
    async query(text) { pool.queries.push(text); return { recordset }; },
  });
  return pool;
}

test('the switch name is the one the timer and the docs use', () => {
  assert.equal(KILL_SWITCH_ENV, 'CONTENT_AGENT_DISABLED');
});

test('unset, empty and the explicit off-words leave the agent enabled', () => {
  assert.equal(isContentAgentDisabled({}), false);
  for (const v of ['', ' ', 'false', 'FALSE', '0', 'no', 'off', 'Off']) {
    assert.equal(isContentAgentDisabled({ CONTENT_AGENT_DISABLED: v }), false, `"${v}" should not disable`);
  }
});

test('ANY other value disables — the switch is deliberately broad', () => {
  // The two mistakes are not symmetric. A switch set to "1" that we read as
  // "still enabled" keeps drafting and keeps spending; a switch set to gibberish
  // that we read as "disabled" costs nothing and says so in the log. This is
  // BROADER than the arion-func timer's `=== "true"`, on purpose, and the
  // asymmetry is safe in one direction only.
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'disabled', 'stop', 'maybe']) {
    assert.equal(isContentAgentDisabled({ CONTENT_AGENT_DISABLED: v }), true, `"${v}" should disable`);
  }
});

test('a disabled tick reads NOTHING and queues NOTHING', async () => {
  const pool = recordingPool([{ tenant_id: 'a0000001-0000-0000-0000-000000000001', enabled: 1 }]);
  const logs = [];
  let cycleCalled = false;
  let notified = false;

  const summary = await runTick({ ownership: ALL_ON,
    pool,
    env: { CONTENT_AGENT_DISABLED: 'true' },
    log: (m) => logs.push(m),
    cycle: async () => { cycleCalled = true; return {}; },
    doResearch: async () => { throw new Error('research must not be reached'); },
    notify: async () => { notified = true; return []; },
  });

  assert.equal(summary.disabled, true);
  assert.equal(summary.killSwitch, 'CONTENT_AGENT_DISABLED');
  assert.equal(summary.tenants, 0);
  assert.equal(summary.ran, 0);
  assert.deepEqual(summary.results, []);
  assert.deepEqual(summary.alerts, []);
  // The load-bearing assertions: no SQL at all, no drafting, no alerting.
  assert.deepEqual(pool.queries, [], 'a disabled tick must not even read the config table');
  assert.equal(cycleCalled, false, 'no cycle may run');
  assert.equal(notified, false, 'a disabled agent has nothing to alert about');
  assert.ok(logs.some((m) => m.includes('CONTENT_AGENT_DISABLED')),
    'the log must name the switch, or an operator cannot tell "off" from "broken"');
});

test('with the switch off the tick does its normal work', async () => {
  // The mirror of the test above: the guard must not be a permanent stop.
  const pool = recordingPool([]);
  const summary = await runTick({ ownership: ALL_ON, pool, env: {}, notify: async () => [] });
  assert.equal(summary.disabled, false);
  assert.match(pool.queries[0], /content_agent_tenant_config/, 'the first thing an enabled tick does is read who is enabled');
  // config read + the 60% margin report that closes every tick
  assert.equal(pool.queries.length, 2, `an enabled tick on an empty platform reads twice, got ${pool.queries.length}`);
  assert.match(pool.queries[1], /content_agent_run_log/, 'the margin report closes the tick');
});

test('the internal tick endpoint is behind the internal-token gate', async () => {
  const router = (await import('../routes/internal.js')).default;
  const layer = router.stack.find((l) => l.route && l.route.path === '/content-agent-tick');
  assert.ok(layer, 'POST /internal/content-agent-tick is not registered');
  assert.deepEqual(Object.keys(layer.route.methods), ['post']);
  const handlers = layer.route.stack.map((h) => h.name);
  assert.equal(handlers[0], 'requireIngestKey',
    'the tick must be gated by the same internal-token check as the other two ticks, first in the chain');
});
