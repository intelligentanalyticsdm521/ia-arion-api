// test/team-job-state.test.mjs — T15: "which businesses have this job ON,
// and how?" (lib/team/jobState.js, CONTRACT_ARGUS_EMPLOYEES_PHASE1 §C.2).
//
// FAILS CLOSED FOR ACTING: no row, a row switched off, a job not built, a
// job description that can't be read, a job that needs a hire with no hire —
// each is "do nothing". An agency has every employee. An always-asks job is
// "Send me first" whatever the row says. A database that cannot be read is
// { ok: false } — never a map, never the last good map, never cached.
//
// The fake pool honours the statement's own `s.enabled = 1`, so a helper that
// drops it reads switched-off rows (mutation M1). Mutations run (edit, run,
// restore): M1 (drop s.enabled = 1), M2 (treat hire-required jobs as hired),
// M3 (return the last good map when the pool throws) each turn this red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobsOn, jobStateFor, clearJobStateCache, JOB_STATE_SQL } from '../lib/team/jobState.js';

const CONTRACT = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-jobs-contract.json', import.meta.url), 'utf8'));
const BLOG_DEF = CONTRACT.definitions.find((d) => d.job_key === 'arion.blog_posts').def;
const T1 = '11111111-2222-4333-8444-555555555555';
const T2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function row(over = {}) {
  return {
    tenant_id: T1, job_key: 'arion.blog_posts', mode: 'review', mode_set_by: null, mode_set_at: null, vars_json: null,
    playbook_id: 'pb-1', playbook_version: 1, state: 'live', setting_home: 'team', mode_rule: 'either', hire_required: true,
    employee_key: 'web', definition_json: JSON.stringify(BLOG_DEF), tenant_kind: 'direct', hired: 1, enabled: true, ...over,
  };
}

function pool(rows, { throws = null } = {}) {
  const seen = [];
  return {
    seen,
    request() {
      const inputs = {};
      const req = {
        input(name, type, value) { inputs[name] = value; return req; },
        async query(text) {
          seen.push({ text, inputs });
          if (throws) throw throws;
          const keys = Object.entries(inputs).filter(([k]) => /^k\d+$/.test(k)).map(([, v]) => v);
          return {
            recordset: rows
              .filter((r) => !/s\.enabled = 1/.test(text) || r.enabled)
              .filter((r) => keys.includes(r.job_key))
              .filter((r) => !inputs.only || r.tenant_id.toLowerCase() === String(inputs.only).toLowerCase()),
          };
        },
      };
      return req;
    },
  };
}
const quiet = () => { const errors = []; return { errors, log: { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} } }; };

test('a switched-on job with a hire and a readable description is in the map, with its settings', async () => {
  const r = await jobsOn(['arion.blog_posts'], { pool: pool([row({ vars_json: '{"posts_per_week":2}' })]) });
  assert.equal(r.ok, true);
  const s = r.on.get(T1.toUpperCase()).get('arion.blog_posts');
  assert.equal(s.mode, 'review');
  assert.equal(s.employeeKey, 'web');
  assert.deepEqual(s.vars, { posts_per_week: 2, seed_topics: [] });
  assert.equal(s.playbook.version, 1);
  assert.equal(s.playbook.def.job, 'arion.blog_posts');
});

test('no row -> not in the map (born off)', async () => {
  const r = await jobsOn(['arion.blog_posts'], { pool: pool([]) });
  assert.equal(r.ok, true);
  assert.equal(r.on.size, 0);
});

test('a row switched off -> not in the map (M1)', async () => {
  const r = await jobsOn(['arion.blog_posts'], { pool: pool([row({ enabled: false })]) });
  assert.equal(r.on.size, 0);
});

test('a job that is not built -> not in the map', async () => {
  const r = await jobsOn(['arion.blog_posts'], { pool: pool([row({ state: 'planned' })]) });
  assert.equal(r.on.size, 0);
  const d = await jobsOn(['arion.blog_posts'], { pool: pool([row({ setting_home: 'door' })]) });
  assert.equal(d.on.size, 0);
});

test('no readable description -> not in the map, and logged at error', async () => {
  for (const definition_json of [null, '{not json', JSON.stringify({ ...BLOG_DEF, job: 'arion.social_posts' })]) {
    const q = quiet();
    const r = await jobsOn(['arion.blog_posts'], { pool: pool([row({ definition_json })]), log: q.log });
    assert.equal(r.on.size, 0);
    assert.match(q.errors.join('\n'), /arion\.blog_posts is on for 11111111-2222-4333-8444-555555555555 with no readable playbook; it does nothing/i);
  }
});

test('a job that needs a hire, with no hire -> not in the map (M2); an agency or platform owner -> in', async () => {
  assert.equal((await jobsOn(['arion.blog_posts'], { pool: pool([row({ hired: 0 })]) })).on.size, 0);
  for (const tenant_kind of ['agency', 'platform_owner']) {
    assert.equal((await jobsOn(['arion.blog_posts'], { pool: pool([row({ hired: 0, tenant_kind })]) })).on.size, 1, tenant_kind);
  }
  const noHireNeeded = await jobsOn(['arion.review_replies'], { pool: pool([row({ job_key: 'arion.review_replies', hire_required: false, hired: 0, definition_json: JSON.stringify(CONTRACT.definitions.find((d) => d.job_key === 'arion.review_replies').def) })]) });
  assert.equal(noHireNeeded.on.size, 1);
});

test('an always-asks job stored as automatic reads "Send me first"; an either job keeps Automatic', async () => {
  const winback = CONTRACT.definitions.find((d) => d.job_key === 'spark.winback').def;
  const r = await jobsOn(['spark.winback'], { pool: pool([row({ job_key: 'spark.winback', mode: 'automatic', mode_rule: 'always_asks', employee_key: 'marketer', definition_json: JSON.stringify(winback) })]) });
  assert.equal(r.on.get(T1.toUpperCase()).get('spark.winback').mode, 'review');
  const a = await jobsOn(['arion.blog_posts'], { pool: pool([row({ mode: 'automatic', mode_set_by: 'Dana Ruiz' })]) });
  const s = a.on.get(T1.toUpperCase()).get('arion.blog_posts');
  assert.equal(s.mode, 'automatic');
  assert.equal(s.modeSetBy, 'Dana Ruiz');
});

test('settings outside their limits fall back to the default, and say so', async () => {
  const q = quiet();
  const r = await jobsOn(['arion.blog_posts'], { pool: pool([row({ vars_json: '{"posts_per_week":40,"seed_topics":["ok"]}' })]), log: q.log });
  assert.deepEqual(r.on.get(T1.toUpperCase()).get('arion.blog_posts').vars, { posts_per_week: 1, seed_topics: ['ok'] });
  assert.match(q.errors.join('\n'), /posts_per_week' is outside its limits/);
});

test('a database that cannot be read is { ok: false } — never a map, never the last good map (M3)', async () => {
  const good = await jobsOn(['arion.blog_posts'], { pool: pool([row()]) });
  assert.equal(good.ok, true);
  const q = quiet();
  const bad = await jobsOn(['arion.blog_posts'], { pool: pool([row()], { throws: new Error('Login failed') }), log: q.log });
  assert.equal(bad.ok, false);
  assert.equal(bad.on, undefined);
  assert.match(bad.error, /Login failed/);
  assert.match(q.errors.join('\n'), /nothing runs this tick/);
  const none = await jobsOn(['arion.blog_posts'], { getPool: async () => { throw new Error('no pool'); }, log: q.log });
  assert.equal(none.ok, false);
  assert.equal((await jobsOn([], { pool: pool([row()]) })).ok, false);
});

test('one business only, when asked', async () => {
  const p = pool([row(), row({ tenant_id: T2 })]);
  const r = await jobsOn(['arion.blog_posts'], { pool: p, tenantId: T2 });
  assert.deepEqual([...r.on.keys()], [T2.toUpperCase()]);
  assert.match(p.seen[0].text, /AND s\.tenant_id = @only$/);
});

test('jobStateFor caches an ok answer for 60 seconds and never caches an ok:false one', async () => {
  clearJobStateCache();
  let t = 1000;
  const now = () => t;
  const bad = await jobStateFor(T1, 'arion.blog_posts', { pool: pool([], { throws: new Error('down') }), now, log: quiet().log });
  assert.equal(bad.ok, false);
  const p = pool([row()]);
  const first = await jobStateFor(T1, 'arion.blog_posts', { pool: p, now });
  assert.equal(first.ok, true);
  assert.equal(first.state.jobKey, 'arion.blog_posts');
  assert.equal(p.seen.length, 1, 'the failure was not cached: this call asked');
  await jobStateFor(T1, 'arion.blog_posts', { pool: p, now });
  assert.equal(p.seen.length, 1, 'cached');
  t += 61_000;
  await jobStateFor(T1, 'arion.blog_posts', { pool: p, now });
  assert.equal(p.seen.length, 2, 'expired after 60 seconds');
  clearJobStateCache();
});

test('the statement is the shared fixture\'s, word for word', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(JOB_STATE_SQL), norm(CONTRACT.job_state_sql));
});
