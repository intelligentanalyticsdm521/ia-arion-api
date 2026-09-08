// test/content-agent-runner-publish.test.js
//
// Task 7 (publish hand-off) + the orchestrator's run-logging contract.
//
// TWO THINGS ARE LOAD-BEARING HERE:
//
// AC8 — nothing reaches WordPress without an explicit approval. The publisher
// refuses on review_status, refuses again on a missing approval timestamp, and
// re-asserts both in the UPDATE's WHERE clause. Tested at each layer because
// "we check it in the app" is how a race gets published.
//
// AC6 — every run is logged, including the ones that fail. The run row is
// written BEFORE any work and updated on every exit path. The mirror of the
// swallow-and-report-success bug is a crash that leaves no row at all, and then
// "what happened last Tuesday" has no answer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPublishable, publishApproved, PublishRefused } from '../lib/contentAgent/publisher.js';
import { runCycle, RUN_STATUS } from '../lib/contentAgent/runner.js';
import { OUTCOME } from '../lib/contentAgent/topicSelection.js';

const TENANT = 'a0000001-0000-0000-0000-000000000001';
const OUTPUT = 'beaa5f9c-df6f-4633-a4ba-b916b6af58dc';

/** Pool that answers by query shape and records every statement. */
function fakePool({ output = null, site = { site_id: 's1', domain: 'x.example.com' }, cycleSpend = 0 } = {}) {
  const pool = {
    queries: [],
    request() {
      const self = this;
      return {
        inputs: {},
        input(n, _t, v) { this.inputs[n] = v; return this; },
        async query(text) {
          self.queries.push({ text, inputs: this.inputs });
          if (/FROM arion\.content_agent_output/i.test(text) && /SELECT/i.test(text)) {
            return { recordset: output ? [output] : [] };
          }
          if (/FROM arion\.site\b/i.test(text)) return { recordset: site ? [site] : [] };
          if (/SUM\(cost_usd\)/i.test(text)) return { recordset: [{ spent: cycleSpend }] };
          if (/INSERT INTO arion\.content_agent_run_log/i.test(text)) {
            return { recordset: [{ run_id: 'run-1' }] };
          }
          if (/OUTPUT INSERTED\.output_id/i.test(text)) return { recordset: [{ output_id: 'out-1' }] };
          return { recordset: [] };
        },
      };
    },
  };
  return pool;
}

const approvedRow = {
  output_id: OUTPUT, site_id: 's1', content_type: 'blog_post',
  title: 'T', body_markdown: 'ORIGINAL draft text',
  body_markdown_final: 'EDITED approved text', meta_description: 'm', url_slug: 's',
  review_status: 'edited', approved_at: new Date().toISOString(), published_at: null,
};

// --- AC8 --------------------------------------------------------------------

test('a pending unit is refused — approval is not implied by existence', async () => {
  await assert.rejects(
    () => loadPublishable(fakePool({ output: { ...approvedRow, review_status: 'pending', approved_at: null } }), TENANT, OUTPUT),
    (e) => { assert.equal(e.code, 'not_approved'); return true; },
  );
});

test('an escalated unit is refused', async () => {
  await assert.rejects(
    () => loadPublishable(fakePool({ output: { ...approvedRow, review_status: 'escalated' } }), TENANT, OUTPUT),
    /Refusing to publish/,
  );
});

test('an approved status with NO approval timestamp is refused', async () => {
  // This shape means something wrote review_status directly, bypassing the
  // review endpoint. Trusting the status alone would let that through.
  await assert.rejects(
    () => loadPublishable(fakePool({ output: { ...approvedRow, approved_at: null } }), TENANT, OUTPUT),
    (e) => { assert.equal(e.code, 'no_approval_timestamp'); return true; },
  );
});

test('an already-published unit is not published twice', async () => {
  await assert.rejects(
    () => loadPublishable(fakePool({ output: { ...approvedRow, published_at: new Date().toISOString() } }), TENANT, OUTPUT),
    (e) => { assert.equal(e.code, 'already_published'); return true; },
  );
});

test('another tenant\'s unit is indistinguishable from a missing one', async () => {
  await assert.rejects(
    () => loadPublishable(fakePool({ output: null }), TENANT, OUTPUT),
    (e) => { assert.equal(e.code, 'not_found'); return true; },
  );
});

// --- AC3 --------------------------------------------------------------------

test('the EDITED text is what gets sent to WordPress, not the original draft', async () => {
  let sent = null;
  const res = await publishApproved({
    pool: fakePool({ output: approvedRow }), tenantId: TENANT, outputId: OUTPUT,
    post: async (_site, _path, body) => { sent = body; return { ok: true, data: { post_id: 99, post_url: 'u' } }; },
  });
  assert.equal(res.ok, true);
  assert.equal(sent.content, 'EDITED approved text', 'AC3: publishing the original would ship the wording Brandon changed');
  assert.notEqual(sent.content, 'ORIGINAL draft text');
});

test('the publish UPDATE re-asserts the approval gate in its WHERE clause', async () => {
  const pool = fakePool({ output: approvedRow });
  await publishApproved({
    pool, tenantId: TENANT, outputId: OUTPUT,
    post: async () => ({ ok: true, data: { post_id: 1 } }),
  });
  const upd = pool.queries.find((q) => /UPDATE arion\.content_agent_output/i.test(q.text) && /published_at\s*=/i.test(q.text));
  assert.ok(upd, 'the publish update ran');
  assert.match(upd.text, /review_status IN \('approved','edited'\)/i, 'a status change between read and write must not slip past');
  assert.match(upd.text, /approved_at IS NOT NULL/i);
  assert.match(upd.text, /published_at IS NULL/i);
  assert.match(upd.text, /tenant_id\s*=\s*@tenantId/i);
});

// --- F5 ---------------------------------------------------------------------

test('a plugin failure leaves the row untouched and raises an F5 alert', async () => {
  const pool = fakePool({ output: approvedRow });
  const res = await publishApproved({
    pool, tenantId: TENANT, outputId: OUTPUT,
    post: async () => ({ ok: false, pluginStatus: 502 }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.alert.failure_mode, 'F5');
  assert.match(res.alert.message, /remains approved and unscheduled/i);
  const upd = pool.queries.find((q) => /published_at = SYSDATETIMEOFFSET/i.test(q.text));
  assert.equal(upd, undefined, 'a failed publish must never mark the row published');
});

test('a thrown plugin error is also F5, not an unhandled crash', async () => {
  const res = await publishApproved({
    pool: fakePool({ output: approvedRow }), tenantId: TENANT, outputId: OUTPUT,
    post: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.alert.failure_mode, 'F5');
});

test('no ARION site is a clean F5, not a 500', async () => {
  const res = await publishApproved({
    pool: fakePool({ output: approvedRow, site: null }), tenantId: TENANT, outputId: OUTPUT,
    post: async () => ({ ok: true, data: {} }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.alert.code, 'no_arion_site');
});

// --- AC6: the run log ------------------------------------------------------

test('a cost-halted tenant opens NO run and does no work', async () => {
  const res = await runCycle({
    pool: fakePool({ cycleSpend: 99 }), tenantId: TENANT,
    research: async () => { throw new Error('research must not be called'); },
  });
  assert.equal(res.status, 'halted');
  assert.equal(res.runId, null);
  assert.equal(res.alerts[0].failure_mode, 'F8');
});

test('E1 closes the run as COMPLETED, not failed — declining a weak post is correct', async () => {
  const res = await runCycle({
    pool: fakePool({ cycleSpend: 0 }), tenantId: TENANT, slots: 1,
    research: async () => [{ keyword: 'impossible', volume: 5000, difficulty: 99, intent: 'informational' }],
  });
  assert.equal(res.outcome, OUTCOME.NO_QUALIFYING_TOPIC);
  assert.equal(res.status, RUN_STATUS.COMPLETED,
    'marking E1 as failed would train the reader to ignore failures');
  assert.equal(res.drafted, 0);
});

test('the run row is opened BEFORE any work, so a crash cannot erase the run', async () => {
  const pool = fakePool({ cycleSpend: 0 });
  await runCycle({
    pool, tenantId: TENANT, slots: 1,
    research: async () => [{ keyword: 'impossible', volume: 5000, difficulty: 99 }],
  });
  const idxInsert = pool.queries.findIndex((q) => /INSERT INTO arion\.content_agent_run_log/i.test(q.text));
  const idxSelect = pool.queries.findIndex((q) => /FROM arion\.content_agent_output/i.test(q.text));
  assert.ok(idxInsert !== -1, 'a run row must exist');
  assert.ok(idxInsert < idxSelect || idxSelect === -1, 'the run row must be written before the work begins');
});

test('a finished run records an array of flags, never null', async () => {
  const pool = fakePool({ cycleSpend: 0 });
  await runCycle({
    pool, tenantId: TENANT, slots: 1,
    research: async () => [{ keyword: 'impossible', volume: 5000, difficulty: 99 }],
  });
  const close = pool.queries.find((q) => /UPDATE arion\.content_agent_run_log/i.test(q.text));
  assert.ok(close);
  assert.notEqual(close.inputs.flags, null,
    '"no flags" and "flags never evaluated" must not look identical in the log');
  assert.doesNotThrow(() => JSON.parse(close.inputs.flags));
});
