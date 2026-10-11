// test/product-ownership.test.mjs — ARION's timers stop for a business whose
// ARION has ended (scope SCOPE_ACCESS_FOLLOWS_SUBSCRIPTION_2026-10-07 §4.3).
//
// LOAD-BEARING ASSERTIONS:
//   * product OFF  → the content agent never drafts for that business and the
//     review replies job never reads (or answers) its reviews; the summary names it;
//   * product ON   → the same runner still does the work (presence, not just
//     absence);
//   * UNREACHABLE  → every business runs exactly as before, reason at error.
//
// lib/productOwnership.js is a declared copy of oliver-api's; the rule tests
// below are the same so a drift in either copy goes red in its own repo.
// All fakes; the server names are blanked so nothing reaches a real pool.
import test from 'node:test';
import assert from 'node:assert/strict';

// Most tests below are about what a timer does ONCE the switch is on: every
// stop waits for ENTITLEMENT_SYNC_MODE to be exactly 'apply' (decision (a),
// 2026-10-08). The dry-run half (mode unset: everything runs as before) is at
// the end of this file and passes the mode explicitly. node --test runs each
// file in its own process, so this does not leak.
process.env.ENTITLEMENT_SYNC_MODE = 'apply';
process.env.SQL_SERVER = '';
process.env.SERVICES_SQL_SERVER = '';
process.env.PLATFORM_SQL_SERVER = '';

const own = await import('../lib/productOwnership.js');
const { filterOwned, checkOwnership, clearOwnershipCache } = own;
const { runTick } = await import('../lib/contentAgent/tick.js');
const { fakeJobsOn, fakeBriefFor } = await import('./helpers/team-job-fakes.mjs');
const { runReviewReplyTick } = await import('../lib/gbpReplyRunner.js');
const { ALLOW_ALL } = await import('./helpers/feature-fakes.mjs');

const ON = '11111111-1111-4111-8111-111111111111';
const OFF = '22222222-2222-4222-8222-222222222222';
const NEVER = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const GHOST = '55555555-5555-4555-8555-555555555555';

const quietLog = () => {
  const lines = { error: [], log: [] };
  return { lines, error: (...a) => lines.error.push(a.join(' ')), log: (...a) => lines.log.push(a.join(' ')), warn() {} };
};

function fakePlatform({ rows = {}, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query(text) {
          calls.push({ text, inputs: { ...inputs } });
          if (fail) throw new Error(fail);
          assert.match(text, /ts\.is_enabled = 1 AND s\.is_active = 1/);
          const ids = JSON.parse(inputs.ids);
          return {
            recordset: ids.filter((id) => rows[id]).map((id) => ({
              tenant_id: id.toLowerCase(), tenant_kind: rows[id].kind || 'direct',
              has_on: Boolean(rows[id].on), has_row: Boolean(rows[id].row || rows[id].on),
            })),
          };
        },
      };
      return req;
    },
  };
}
const STANDARD_ROWS = { [ON]: { on: true }, [OFF]: { row: true }, [NEVER]: {}, [OWNER]: { kind: 'platform_owner' } };
const ownershipOver = (platform, log) => (product, ids) => checkOwnership(product, ids, { getPlatformPool: async () => platform, log });
const ownershipUnreachable = (log) => (product, ids) =>
  checkOwnership(product, ids, { getPlatformPool: async () => { throw new Error('connect ETIMEDOUT'); }, log });

/** Services pool: answers by regex, records everything. */
function fakeServices(answers) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = arguments.length === 2 ? _t : v; return req; },
        async query(text) {
          calls.push({ text, inputs: { ...inputs } });
          for (const [re, rows] of answers) if (re.test(text)) return { recordset: rows.map((r) => ({ ...r })), rowsAffected: [rows.length] };
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
}

test.beforeEach(() => clearOwnershipCache());

/* ── the rule (same cases as oliver-api's copy) ─────────────────────────── */

test('filterOwned: on, switched off, never bought, platform owner, missing', async () => {
  const log = quietLog();
  const v = await filterOwned(fakePlatform({ rows: STANDARD_ROWS }), 'arion', [ON, OFF, NEVER, OWNER, GHOST], { log });
  assert.deepEqual(v.owned, [ON, OWNER, GHOST]);
  assert.deepEqual(v.off.map((o) => o.tenantId), [OFF, NEVER]);
  assert.equal(v.off[0].reason, 'ARION is switched off');
  assert.equal(v.off[1].reason, "ARION is not part of this business's plan");
  assert.ok(log.lines.error.some((l) => l.includes(GHOST)));
});

test('filterOwned: an agency is kept', async () => {
  const v = await filterOwned(fakePlatform({ rows: { [OFF]: { kind: 'agency', row: true } } }), 'arion', [OFF], { log: quietLog() });
  assert.deepEqual(v.owned, [OFF]);
});

test('filterOwned: a failed read or an empty answer is undecided and keeps everyone', async () => {
  for (const p of [fakePlatform({ fail: 'Login failed' }), fakePlatform({ rows: {} }), null]) {
    clearOwnershipCache();
    const log = quietLog();
    const v = await filterOwned(p, 'arion', [ON, OFF], { log });
    assert.equal(v.undecided, true);
    assert.deepEqual(v.owned, [ON, OFF]);
    assert.ok(log.lines.error.length >= 1);
  }
});

test('F11: the service key comes from ARION_SERVICE_KEY, the setting requireArionAccess reads', async () => {
  const p = fakePlatform({ rows: { [ON]: { on: true } } });
  const v = await filterOwned(p, 'arion', [ON], { log: quietLog(), env: { ARION_SERVICE_KEY: 'arion_web' } });
  assert.equal(p.calls[0].inputs.product, 'arion_web');
  assert.deepEqual(v.owned, [ON]);
  assert.equal(own.serviceKeyFor('arion', {}), 'arion');
});

test('the note never says tenant and does not repeat the reason in brackets', () => {
  const s = own.skipSentence('arion', false, 'the content agent did not draft anything');
  assert.equal(s, "ARION isn't part of this business's plan, so the content agent did not draft anything.");
  assert.doesNotMatch(s, /tenant|\(/i);
});

test('filterOwned: failures are never cached', async () => {
  const bad = fakePlatform({ fail: 'down' });
  await filterOwned(bad, 'arion', [ON], { log: quietLog() });
  await filterOwned(bad, 'arion', [ON], { log: quietLog() });
  assert.equal(bad.calls.length, 2);
});

/* ── the content agent ──────────────────────────────────────────────────── */

// ARGUS employees phase 1: who runs is the jobs that are on (jobsOn); the
// ownership check still runs right after, on the same businesses.
async function contentTick(ownership) {
  const pool = fakeServices([]);
  const ranFor = [];
  const researchedFor = [];
  const logs = [];
  const summary = await runTick({
    pool, env: {}, ownership, log: (m) => logs.push(m), notify: async () => [],
    jobsOn: fakeJobsOn({ [ON]: ['arion.blog_posts'], [OFF]: ['arion.blog_posts'] }),
    briefFor: fakeBriefFor(),
    cycle: async ({ tenantId }) => { ranFor.push(tenantId); return { runId: 'r', status: 'completed', outcome: 'selected', drafted: 1, escalated: 0, costUsd: 0, alerts: [] }; },
    doResearch: async (_p, tenantId) => { researchedFor.push(tenantId); return { provider: 'none', rows: [], detail: 'test' }; },
  });
  return { summary, ranFor, researchedFor, logs, pool };
}

test('content agent: ARION off → no drafting, no research for that business; the summary says so', async () => {
  const log = quietLog();
  const platform = fakePlatform({ rows: STANDARD_ROWS });
  const { summary, ranFor, researchedFor, logs, pool } = await contentTick(ownershipOver(platform, log));
  assert.equal(platform.calls[0].inputs.product, 'arion');
  assert.deepEqual(ranFor, [ON], 'the business with ARION is still drafted for');
  assert.deepEqual(researchedFor, [ON]);
  assert.ok(!pool.calls.some((c) => Object.values(c.inputs).some((v) => String(v).toLowerCase() === OFF)), 'no statement for the ended business');
  assert.deepEqual(summary.productOff.skipped.map((s) => s.tenantId), [OFF]);
  assert.equal(summary.productOff.skipped[0].note, "ARION has ended for this business, so the web person didn't write anything. It starts again after a re-subscribe.");
  assert.ok(logs.some((m) => m.includes(OFF) && m.includes("didn't write anything")));
});

test('content agent: platform database unreachable → runs for every business as before', async () => {
  const log = quietLog();
  const { summary, ranFor } = await contentTick(ownershipUnreachable(log));
  assert.deepEqual(ranFor.sort(), [ON, OFF].sort());
  assert.equal(summary.productOff.undecided, true);
  assert.ok(log.lines.error.length >= 1);
});

test('content agent: the platform read throws → runs for every business as before', async () => {
  const { ranFor } = await contentTick(ownershipOver(fakePlatform({ fail: 'Login failed for user' }), quietLog()));
  assert.deepEqual(ranFor.sort(), [ON, OFF].sort());
});

/* ── Google review replies ──────────────────────────────────────────── */
// ARGUS employees phase 1: the job is on for both businesses (jobsOn); the
// ownership check still decides, right after, who is read.

const site = (tenantId, n) => ({
  tenant_id: tenantId, site_id: `site-${n}`, arion_tier: 'pro', gbp_location_name: `locations/${n}`,
  gbp_oauth_token_ref: `ref-${n}`,
});

async function gbpTick(ownership) {
  const pool = fakeServices([
    [/FROM arion\.site\s+WHERE tenant_id IN/, [site(ON, 1), site(OFF, 2)]],
    [/INSERT INTO arion\.gbp_reply_run/, [{ run_id: 'run-1' }]],
  ]);
  const readFor = [];
  const logs = [];
  const summary = await runReviewReplyTick(pool, (m) => logs.push(m), {
    ownership, getEntitlements: ALLOW_ALL,
    jobsOn: fakeJobsOn({ [ON]: ['arion.review_replies'], [OFF]: ['arion.review_replies'] }),
    briefFor: fakeBriefFor(),
    api: { fetchReviews: async (ref) => { readFor.push(ref); return { reviews: [] }; }, replyToReview: async () => ({}) },
  });
  return { summary, readFor, logs };
}

test('review replies: ARION off → that business\'s reviews are never read or answered', async () => {
  const log = quietLog();
  const { summary, readFor, logs } = await gbpTick(ownershipOver(fakePlatform({ rows: STANDARD_ROWS }), log));
  assert.deepEqual(readFor, ['ref-1'], 'the business with ARION is still answered');
  assert.equal(summary.sitesEligible, 1);
  assert.deepEqual(summary.productOff.skipped.map((s) => s.tenantId), [OFF]);
  assert.equal(summary.productOff.skipped[0].note, 'ARION has ended for this business, so no Google review was answered. It starts again after a re-subscribe.');
  assert.ok(logs.some((m) => m.includes(OFF)));
});

test('review replies: platform database unreachable → runs for every business as before', async () => {
  const { summary, readFor } = await gbpTick(ownershipUnreachable(quietLog()));
  assert.deepEqual(readFor.sort(), ['ref-1', 'ref-2']);
  assert.equal(summary.productOff.undecided, true);
});

test('review replies: the platform read throws → runs for every business as before', async () => {
  const { readFor } = await gbpTick(ownershipOver(fakePlatform({ fail: 'boom' }), quietLog()));
  assert.deepEqual(readFor.sort(), ['ref-1', 'ref-2']);
});

test('both runners default to the real check (no stub on the seam)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['lib/contentAgent/tick.js', 'lib/gbpReplyRunner.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /ownership = checkOwnership/, `${f} must default to checkOwnership`);
  }
  const lib = readFileSync(new URL('../lib/productOwnership.js', import.meta.url), 'utf8');
  assert.match(lib, /import\("\.\.\/db\/platformPool\.js"\)\)\.getPlatformPool/);
});

/* ── decision (a): nothing stops before ENTITLEMENT_SYNC_MODE=apply ─────── */

// Production already has rows off (Briarwood Dental, Midwest Ag Services). On
// push day, with the mode unset, every runner must behave exactly as before
// the stream. These assert PRESENCE: the ended business IS run for.
const ownershipWithMode = (platform, log, env) => (product, ids) =>
  checkOwnership(product, ids, { getPlatformPool: async () => platform, log, env });

test("timerStopsLive: only the exact word 'apply' lets a timer stop", () => {
  assert.equal(own.timerStopsLive({ ENTITLEMENT_SYNC_MODE: 'apply' }), true);
  for (const v of [undefined, '', 'dry_run', 'APPLY', ' apply', 'true']) {
    assert.equal(own.timerStopsLive(v === undefined ? {} : { ENTITLEMENT_SYNC_MODE: v }), false, JSON.stringify(v));
  }
});

test('content agent, mode unset: the ended business is drafted for exactly as before, and listed as held', async () => {
  const { summary, ranFor, researchedFor } = await contentTick(ownershipWithMode(fakePlatform({ rows: STANDARD_ROWS }), quietLog(), {}));
  assert.deepEqual(ranFor.sort(), [ON, OFF].sort());
  assert.deepEqual(researchedFor.sort(), [ON, OFF].sort());
  assert.deepEqual(summary.productOff.skipped, []);
  assert.deepEqual(summary.productOff.held.map((h) => h.tenantId), [OFF]);
  assert.equal(summary.productOff.mode, 'dry_run');
});

test("review replies, mode unset: the ended business's reviews are read exactly as before", async () => {
  const { summary, readFor } = await gbpTick(ownershipWithMode(fakePlatform({ rows: STANDARD_ROWS }), quietLog(), {}));
  assert.deepEqual(readFor.sort(), ['ref-1', 'ref-2']);
  assert.deepEqual(summary.productOff.skipped, []);
  assert.deepEqual(summary.productOff.held.map((h) => h.tenantId), [OFF]);
});

test('mode apply passed explicitly: the same businesses are stopped (the switch is not stuck open)', async () => {
  const { ranFor } = await contentTick(ownershipWithMode(fakePlatform({ rows: STANDARD_ROWS }), quietLog(), { ENTITLEMENT_SYNC_MODE: 'apply' }));
  assert.deepEqual(ranFor, [ON]);
});
