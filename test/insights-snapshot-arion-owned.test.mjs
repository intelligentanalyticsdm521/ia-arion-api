// test/insights-snapshot-arion-owned.test.mjs — the monthly IA Insights
// snapshot runs only for businesses that own ARION (FEATURES row 26,
// 11 Oct 2026).
//
// Runs the real runFullInsightsSnapshot with the real checkOwnership over a
// fake platform database (apply mode, as production is now) and a fake
// services pool that records every statement:
//   ARION ended      -> the business is left out; no statement names its site
//   ARION owned      -> its site is snapshotted as before
//   unreachable      -> every site runs as before (never deny on "we don't know")
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SQL_SERVER = '';
process.env.SERVICES_SQL_SERVER = '';
process.env.PLATFORM_SQL_SERVER = '';

const { checkOwnership, clearOwnershipCache } = await import('../lib/productOwnership.js');
const { runFullInsightsSnapshot } = await import('../lib/insightsSnapshot.js');

const ON = '11111111-1111-4111-8111-111111111111';
const OFF = '22222222-2222-4222-8222-222222222222';
const SITE_ON = 'aaaaaaaa-0000-4000-8000-000000000001';
const SITE_OFF = 'aaaaaaaa-0000-4000-8000-000000000002';
const APPLY = { ENTITLEMENT_SYNC_MODE: 'apply' };
const quiet = { error() {}, log() {}, warn() {} };

function fakePlatform(rows, fail = null) {
  return {
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query() {
          if (fail) throw new Error(fail);
          const ids = JSON.parse(inputs.ids);
          return {
            recordset: ids.filter((id) => rows[id]).map((id) => ({
              tenant_id: id.toLowerCase(), tenant_kind: 'direct',
              has_on: Boolean(rows[id].on), has_row: true,
            })),
          };
        },
      };
      return req;
    },
  };
}

function fakeServices() {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query(text) {
          calls.push({ text: String(text), inputs: { ...inputs } });
          if (/FROM arion\.site WHERE domain IS NOT NULL/.test(text)) {
            return {
              recordset: [
                { site_id: SITE_ON, tenant_id: ON, domain: 'owned.example.test' },
                { site_id: SITE_OFF, tenant_id: OFF, domain: 'ended.example.test' },
              ],
            };
          }
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
}

const touched = (pool, siteId) => pool.calls.some((c) => Object.values(c.inputs).some((v) => String(v).toLowerCase() === siteId));
const ownership = (platform) => (product, ids) => checkOwnership(product, ids, { getPlatformPool: async () => platform, log: quiet, env: APPLY });

test('ARION ended: the business is left out and its rows are not touched; the owned one runs as before', async () => {
  clearOwnershipCache();
  const pool = fakeServices();
  const summary = await runFullInsightsSnapshot(pool, () => {}, { ownership: ownership(fakePlatform({ [ON]: { on: true }, [OFF]: {} })) });
  assert.equal(summary.sites, 1);
  assert.equal(summary.sitesLeftOut, 1);
  assert.equal(touched(pool, SITE_OFF), false, 'no statement names the ended business\'s site');
  assert.equal(touched(pool, SITE_ON), true, 'the owned site is snapshotted');
  assert.ok(summary.results['owned.example.test']);
  assert.equal(summary.results['ended.example.test'], undefined);
  assert.equal(summary.productOff.skipped.length, 1);
  assert.match(summary.productOff.skipped[0].note, /ARION has ended for this business, so no IA Insights snapshot was taken/);
});

test('platform database unreachable: every site runs as before', async () => {
  clearOwnershipCache();
  const pool = fakeServices();
  const summary = await runFullInsightsSnapshot(pool, () => {}, { ownership: ownership(fakePlatform({}, 'connect ETIMEDOUT')) });
  assert.equal(summary.sites, 2);
  assert.equal(touched(pool, SITE_OFF), true);
  assert.equal(touched(pool, SITE_ON), true);
});
