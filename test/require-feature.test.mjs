/**
 * The feature catalog's rule in arion-api (scope 2.4, 11 Oct 2026): one gate,
 * requireFeature(key), reading platform-api's payload.features[key].
 *
 * Runs the REAL lib/featureGate.js and middleware/requireFeature.js with
 * platform-api stubbed (getEntitlements seam). No network, no database.
 *   allowed false            -> 403 feature_not_in_plan, the plan named (needs)
 *   allowed null + a read    -> runs (logged)
 *   allowed null + a send    -> held (503, nothing done)
 *   allowed true             -> runs
 *   key missing              -> read runs, send holds (logged at error)
 *   no payload / catalog unreadable -> the same as undecided
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureGate, featureDecision, HOLDING_INTENTS } from '../lib/featureGate.js';
import { requireFeature, intentForMethod } from '../middleware/requireFeature.js';
import { entry, planSaying, UNREACHABLE } from './helpers/feature-fakes.mjs';

const TENANT = '11111111-2222-3333-4444-555555555555';
const KEY = 'arion_website_staging';

const quiet = async (fn) => {
  const e = console.error; const w = console.warn; const lines = [];
  console.error = (...a) => lines.push(['error', a.join(' ')]);
  console.warn = (...a) => lines.push(['warn', a.join(' ')]);
  try { return { out: await fn(), lines }; } finally { console.error = e; console.warn = w; }
};

async function drive(mw, { method = 'GET', url = '/arion/staging' } = {}) {
  const req = { method, originalUrl: url, path: url, tenant: { tenantId: TENANT } };
  let status = 200; let body = null; let passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await mw(req, res, () => { passed = true; });
  return { passed, status, body, req };
}

test('featureGate: the decision table (verbatim copy of platform-api featureGate)', () => {
  const f = { a: entry(true), b: entry(false), c: entry(null) };
  assert.deepEqual(HOLDING_INTENTS, ['send', 'cross_write', 'spend', 'job']);
  assert.equal(featureGate(f, 'a', 'send').action, 'run');
  const refused = featureGate(f, 'b', 'read');
  assert.equal(refused.action, 'refuse');
  assert.deepEqual(refused.body, { error: 'feature_not_in_plan', feature: 'b', needs: 'ARION Pro', message: 'Not in your plan. This needs ARION Pro.' });
  for (const i of ['read', 'write']) assert.equal(featureGate(f, 'c', i).action, 'run', i);
  for (const i of HOLDING_INTENTS) assert.equal(featureGate(f, 'c', i).action, 'hold', i);
  const miss = featureGate(f, 'nope', 'read');
  assert.equal(miss.action, 'run'); assert.equal(miss.log, 'error');
  assert.equal(featureGate(f, 'nope', 'send').action, 'hold');
  assert.equal(featureGate({ x: entry(false, { needs: null }) }, 'x').body.message, 'Not available for this business.');
});

test('intentForMethod: GET/HEAD/OPTIONS read, the rest write', () => {
  for (const m of ['GET', 'head', 'OPTIONS', undefined]) assert.equal(intentForMethod(m), 'read');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(intentForMethod(m), 'write');
});

test('requireFeature: allowed false -> 403 with the plan named; the route never runs', async () => {
  const r = await drive(requireFeature(KEY, { getEntitlements: planSaying({ [KEY]: entry(false) }) }));
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'feature_not_in_plan');
  assert.equal(r.body.feature, KEY);
  assert.equal(r.body.needs, 'ARION Pro');
  assert.match(r.body.message, /Not in your plan\. This needs ARION Pro\./);
});

test('requireFeature: allowed true -> runs, and the request carries which feature let it in', async () => {
  const r = await drive(requireFeature(KEY, { getEntitlements: planSaying({ [KEY]: entry(true) }) }), { method: 'POST' });
  assert.equal(r.passed, true);
  assert.deepEqual(r.req.feature, { key: KEY, allowed: true, needs: null });
});

test('requireFeature: allowed null -> a read runs (logged), a send is HELD', async () => {
  const plan = planSaying({ [KEY]: entry(null) });
  const read = await quiet(() => drive(requireFeature(KEY, { getEntitlements: plan })));
  assert.equal(read.out.passed, true);
  assert.ok(read.lines.some(([, l]) => l.includes(KEY) && l.includes('-> run')), 'logged');
  const write = await quiet(() => drive(requireFeature(KEY, { getEntitlements: plan }), { method: 'POST' }));
  assert.equal(write.out.passed, true, 'a signed-in write runs on undecided');
  const send = await quiet(() => drive(requireFeature(KEY, { getEntitlements: plan, intent: 'send' }), { method: 'POST' }));
  assert.equal(send.out.passed, false);
  assert.equal(send.out.status, 503);
  assert.equal(send.out.body.error, 'plan_not_confirmed');
  assert.match(send.out.body.message, /nothing was done/);
});

test('requireFeature: a key missing from the answer is a catalog mismatch: read runs, send holds, logged at error', async () => {
  const plan = planSaying({ [KEY]: undefined });
  const read = await quiet(() => drive(requireFeature(KEY, { getEntitlements: plan })));
  assert.equal(read.out.passed, true);
  assert.ok(read.lines.some(([lvl, l]) => lvl === 'error' && l.includes('not in the catalog answer')));
  const send = await quiet(() => drive(requireFeature(KEY, { getEntitlements: plan, intent: 'spend' }), { method: 'POST' }));
  assert.equal(send.out.status, 503);
});

test('requireFeature: platform-api unreachable, or its catalog unreadable -> undecided (read runs, send holds)', async () => {
  for (const getEntitlements of [UNREACHABLE, planSaying({}, { catalog: 'unreadable' }), async () => { throw new Error('down'); }]) {
    const read = await quiet(() => drive(requireFeature(KEY, { getEntitlements })));
    assert.equal(read.out.passed, true);
    const send = await quiet(() => drive(requireFeature(KEY, { getEntitlements, intent: 'send' })));
    assert.equal(send.out.status, 503);
  }
});

test('requireFeature: no business resolved -> left to tenantResolution (passes, never asks)', async () => {
  let asked = 0;
  const mw = requireFeature(KEY, { getEntitlements: async () => { asked++; return null; } });
  let passed = false;
  await mw({ method: 'GET', originalUrl: '/x' }, {}, () => { passed = true; });
  assert.equal(passed, true); assert.equal(asked, 0);
});

test('requireFeature: refuses to be built without a key', () => {
  assert.throws(() => requireFeature(''), /catalog feature key/);
});

test('featureDecision: returns the catalog entry for callers that need its facts', async () => {
  const d = await featureDecision(TENANT, 'arion_seo_market_monitor', 'read', {
    getEntitlements: planSaying({ arion_seo_market_monitor: entry(true, { addon: 'seo', addon_min_tier: 'authority' }) }),
  });
  assert.equal(d.action, 'run');
  assert.equal(d.entry.addon_min_tier, 'authority');
});
