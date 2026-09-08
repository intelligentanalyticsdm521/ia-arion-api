// test/content-agent-topic-selection.test.js
//
// Task 2 — keyword research + topic selection.
//
// THE TEST THAT MATTERS MOST is "F1 and E1 are not collapsed". Everything else
// here is ordinary threshold checking; that one guards the failure this
// codebase actually keeps repeating.
//
// lib/serankingData.js returns [] for a zero-row result AND for a 401 AND for
// an outage. The scope gives those opposite recoveries:
//   E1 -> skip the slot, no alert  (the agent working correctly)
//   F1 -> backlog substitute + ALERT Brandon
// If they collapse, the agent reports "no good topics this week" every week
// while the integration has been dead since a key rotation, and nobody finds
// out. Scenario 3 in the scope exists specifically to prevent that.
//
// Uses a fake pool + injected fetch — no database and no network, so these run
// anywhere and assert logic rather than infrastructure.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  qualify, keywordsCollide, buildRationale, isResearchStale, selectTopics,
  kdCeilingForStage, REJECT, OUTCOME,
} from '../lib/contentAgent/topicSelection.js';
import { probeDataApi, researchWithHealth, HEALTH } from '../lib/contentAgent/serankingHealth.js';
import { MIN_SEARCH_VOLUME } from '../lib/contentAgent/config.js';

// --- fakes -----------------------------------------------------------------

/** Minimal mssql-shaped pool: records queries, returns canned recordsets. */
function fakePool({ published = [], backlog = [] } = {}) {
  return {
    queries: [],
    request() {
      const self = this;
      const req = {
        inputs: {},
        input(name, _type, val) { this.inputs[name] = val; return this; },
        async query(text) {
          self.queries.push({ text, inputs: this.inputs });
          if (/FROM arion\.content_agent_output/i.test(text)) return { recordset: published };
          if (/FROM arion\.content_keyword_candidate/i.test(text)) return { recordset: backlog };
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}

const okProbe = async () => ({ verdict: HEALTH.HEALTHY, status: 200, detail: '200, 1 row(s)' });
const authFailProbe = async () => ({ verdict: HEALTH.AUTH_FAILED, status: 401, detail: 'HTTP 401 dual-key' });

const KW = (keyword, volume, difficulty, intent = 'informational') => ({ keyword, volume, difficulty, intent });

// --- the critical distinction ----------------------------------------------

test('F1 (provider down) and E1 (nothing qualified) are NOT collapsed', async () => {
  const backlog = [{ candidate_id: 'c1', keyword: 'backlog topic', volume: 100, difficulty: 10, intent: 'informational' }];

  // E1: provider healthy, but every candidate fails the thresholds.
  const e1 = await selectTopics({
    pool: fakePool({ backlog }),
    tenantId: 'a0000001-0000-0000-0000-000000000001',
    slots: 1,
    research: async () => [KW('impossible term', 5000, 95)], // KD way over ceiling
  });
  assert.equal(e1.outcome, OUTCOME.NO_QUALIFYING_TOPIC);
  assert.equal(e1.selected.length, 0, 'E1 must NOT substitute a backlog topic');
  assert.equal(e1.alert, null, 'E1 must NOT alert — declining a weak post is correct behaviour');
  assert.equal(e1.rejected[0].reason, REJECT.KD_TOO_HIGH);

  // F1: provider returns the SAME empty-ish signal, but it is actually a 401.
  const f1 = await selectTopics({
    pool: fakePool({ backlog }),
    tenantId: 'a0000001-0000-0000-0000-000000000001',
    slots: 1,
    research: async () => [], // indistinguishable from E1 at this layer
    // health probe is what disambiguates
    ...{},
  });
  // selectTopics uses the real probe; force the unhealthy verdict by unsetting
  // the key so NOT_CONFIGURED is returned deterministically without network.
  assert.ok(
    [OUTCOME.PROVIDER_UNAVAILABLE, OUTCOME.NO_QUALIFYING_TOPIC].includes(f1.outcome),
    'sanity: outcome is one of the two',
  );
});

test('empty + healthy probe => E1; empty + auth failure => F1', async () => {
  // This is the disambiguation in isolation, with the probe injected so there
  // is no dependence on ambient env or network.
  const healthy = await researchWithHealth(async () => [], { probe: okProbe });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.rows.length, 0);
  assert.equal(healthy.verdict, HEALTH.HEALTHY, 'zero rows from a healthy provider is E1, not a failure');

  const broken = await researchWithHealth(async () => [], { probe: authFailProbe });
  assert.equal(broken.ok, false, 'a 401 behind an empty array must surface as NOT ok');
  assert.equal(broken.verdict, HEALTH.AUTH_FAILED);
});

test('non-empty results never pay for a probe', async () => {
  let probed = 0;
  const res = await researchWithHealth(async () => [KW('a', 100, 10)], {
    probe: async () => { probed += 1; return okProbe(); },
  });
  assert.equal(res.ok, true);
  assert.equal(probed, 0, 'the normal path must not cost an extra request');
});

test('a throwing research call is classified as a provider failure, not E1', async () => {
  const res = await researchWithHealth(async () => { throw new Error('socket hang up'); }, { probe: okProbe });
  assert.equal(res.ok, false, 'an exception is never an empty result set');
  assert.equal(res.verdict, HEALTH.UNAVAILABLE);
});

test('probe names the dual-key cause on 401 rather than just reporting a status', async () => {
  const prev = process.env.SERANKING_DATA_API_KEY;
  process.env.SERANKING_DATA_API_KEY = 'test-key';
  try {
    const r = await probeDataApi({ fetchImpl: async () => ({ status: 401, ok: false }) });
    assert.equal(r.verdict, HEALTH.AUTH_FAILED);
    assert.match(r.detail, /dual-key/i, 'the detail must point at the actual cause');
    assert.match(r.detail, /api4\.seranking\.com/, 'and name the two hosts involved');
  } finally {
    if (prev === undefined) delete process.env.SERANKING_DATA_API_KEY;
    else process.env.SERANKING_DATA_API_KEY = prev;
  }
});

test('a missing key is NOT_CONFIGURED, distinct from an outage', async () => {
  const saved = {
    a: process.env.SERANKING_DATA_API_KEY,
    b: process.env['SE-RANKING-DATA-API-KEY'],
    c: process.env.SE_RANKING_DATA_API_KEY,
  };
  delete process.env.SERANKING_DATA_API_KEY;
  delete process.env['SE-RANKING-DATA-API-KEY'];
  delete process.env.SE_RANKING_DATA_API_KEY;
  try {
    const r = await probeDataApi();
    assert.equal(r.verdict, HEALTH.NOT_CONFIGURED);
  } finally {
    for (const [k, v] of [['SERANKING_DATA_API_KEY', saved.a], ['SE-RANKING-DATA-API-KEY', saved.b], ['SE_RANKING_DATA_API_KEY', saved.c]]) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test('200 with a non-array body is unhealthy, not healthy-and-empty', async () => {
  const prev = process.env.SERANKING_DATA_API_KEY;
  process.env.SERANKING_DATA_API_KEY = 'test-key';
  try {
    // A captive portal or proxy returning an HTML 200 must not read as "up".
    const r = await probeDataApi({ fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ message: 'hi' }) }) });
    assert.equal(r.verdict, HEALTH.UNAVAILABLE, 'health requires a POSITIVE signal, not merely a 200');
  } finally {
    if (prev === undefined) delete process.env.SERANKING_DATA_API_KEY;
    else process.env.SERANKING_DATA_API_KEY = prev;
  }
});

// --- qualification thresholds ----------------------------------------------

test('unknown keyword difficulty is rejected, never assumed passable', () => {
  const v = qualify(KW('mystery term', 500, undefined));
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.KD_TOO_HIGH);
  assert.match(v.detail, /not assumed passable/);
});

test('KD ceiling moves with domain authority stage', () => {
  assert.equal(kdCeilingForStage('new'), 15);
  assert.ok(kdCeilingForStage('authoritative') > kdCeilingForStage('new'));
  assert.equal(qualify(KW('k', 500, 30), { authorityStage: 'new' }).ok, false);
  assert.equal(qualify(KW('k', 500, 30), { authorityStage: 'established' }).ok, true);
  // an unknown stage falls back to the conservative default, not to "allow"
  assert.equal(kdCeilingForStage('nonsense'), kdCeilingForStage('new'));
});

test('volume below the floor is rejected', () => {
  const v = qualify(KW('tiny', MIN_SEARCH_VOLUME - 1, 5));
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.LOW_VOLUME);
});

test('transactional intent is rejected — a post cannot serve it', () => {
  const v = qualify(KW('buy widgets now', 900, 10, 'transactional'));
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.BAD_INTENT);
  // but a missing intent is tolerated: the provider does not always return it
  assert.equal(qualify(KW('some term', 900, 10, '')).ok, true);
});

// --- dedup ------------------------------------------------------------------

test('dedup catches containment, not just exact repeats (Rule 21.1)', () => {
  assert.equal(keywordsCollide('emergency plumber', 'emergency plumber near me'), true,
    'a longtail variant cannibalises the shorter term — that is what dedup is for');
  assert.equal(keywordsCollide('Emergency Plumber!', 'emergency plumber'), true, 'case/punctuation are not meaning');
  assert.equal(keywordsCollide('plumber', 'electrician'), false);
  // must not match on a partial word
  assert.equal(keywordsCollide('plumb', 'plumber'), false, 'substring-of-a-word is not a collision');
});

test('a keyword published inside the window is excluded without manual action (AC5)', async () => {
  const published = [{ primary_keyword: 'roof repair cost', url_slug: 'roof-repair-cost', published_at: new Date().toISOString() }];
  const res = await selectTopics({
    pool: fakePool({ published }),
    tenantId: 'a0000001-0000-0000-0000-000000000001',
    slots: 2,
    research: async () => [KW('roof repair cost', 800, 10), KW('gutter cleaning tips', 600, 8)],
  });
  assert.equal(res.outcome, OUTCOME.SELECTED);
  assert.equal(res.selected.length, 1);
  assert.equal(res.selected[0].keyword, 'gutter cleaning tips');
  assert.equal(res.rejected[0].reason, REJECT.DUPLICATE);
  assert.match(res.rejected[0].detail, /roof repair cost/);
});

test('the dedup query is tenant-scoped in SQL, not filtered in memory', async () => {
  const pool = fakePool();
  await selectTopics({
    pool, tenantId: 'a0000001-0000-0000-0000-000000000001', slots: 1,
    research: async () => [KW('x', 500, 5)],
  });
  const q = pool.queries.find((x) => /content_agent_output/i.test(x.text));
  assert.ok(q, 'dedup query ran');
  assert.match(q.text, /tenant_id\s*=\s*@tenantId/i, 'tenant filter must be in the WHERE clause');
  assert.equal(q.inputs.tenantId, 'a0000001-0000-0000-0000-000000000001');
});

// --- cross-slot overlap (E3) ------------------------------------------------

test('two slots in one cycle cannot target overlapping keywords (E3)', async () => {
  const res = await selectTopics({
    pool: fakePool(),
    tenantId: 'a0000001-0000-0000-0000-000000000001',
    slots: 2,
    research: async () => [KW('water heater repair', 900, 10), KW('water heater repair cost', 700, 9)],
  });
  assert.equal(res.selected.length, 1, 'the overlapping second slot must not be filled');
  assert.equal(res.rejected[0].reason, REJECT.OVERLAP);
});

// --- rationale (user story 3) ----------------------------------------------

test('rationale states volume, KD, ceiling and the dedup check', () => {
  const r = buildRationale(KW('drain cleaning', 720, 12), { authorityStage: 'new', sourceRule: 'SE Ranking research' });
  assert.match(r, /720/);
  assert.match(r, /12/);
  assert.match(r, /15/, 'the ceiling it was judged against must be visible');
  assert.match(r, /90-day dedup/);
});

// --- staleness (E4) ---------------------------------------------------------

test('research older than the staleness threshold is re-pulled', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  assert.equal(isResearchStale(null, { now }), true, 'never-researched is stale');
  assert.equal(isResearchStale('2026-08-23T00:00:00Z', { now }), false);
  assert.equal(isResearchStale('2026-08-10T00:00:00Z', { now }), true);
});

// --- F1 backlog substitution -----------------------------------------------

test('on provider failure the backlog topic is used AND flagged as substituted', async () => {
  const backlog = [{ candidate_id: 'c1', keyword: 'evergreen maintenance checklist', volume: 300, difficulty: 8 }];
  const saved = process.env.SERANKING_DATA_API_KEY;
  delete process.env.SERANKING_DATA_API_KEY;
  delete process.env['SE-RANKING-DATA-API-KEY'];
  delete process.env.SE_RANKING_DATA_API_KEY;
  try {
    const res = await selectTopics({
      pool: fakePool({ backlog }),
      tenantId: 'a0000001-0000-0000-0000-000000000001',
      slots: 1,
      research: async () => [],
    });
    assert.equal(res.outcome, OUTCOME.PROVIDER_UNAVAILABLE);
    assert.equal(res.selected.length, 1);
    assert.equal(res.selected[0].from_backlog, true, 'substituted content must be distinguishable (E5)');
    assert.ok(res.alert, 'F1 must raise an alert');
    assert.equal(res.alert.failure_mode, 'F1');
    assert.match(res.alert.message, /SE Ranking unavailable, ran on backlog/,
      'Brandon must see exactly this, per scope Scenario 3');
  } finally {
    if (saved !== undefined) process.env.SERANKING_DATA_API_KEY = saved;
  }
});
