// The ARION self-serve grant names billing_source (migration 041). If this
// code reaches a database before 041 does, the grant must still go in, or a
// buyer who just paid has no ARION (review finding F11, 2026-10-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { enableServiceForTenant, PAID_SERVICE_INSERT_SQL, PAID_SERVICE_INSERT_LEGACY_SQL } from '../lib/coreTenants.js';

function pool({ has041 }) {
  const ran = [];
  return {
    ran,
    request() {
      const rq = {
        input() { return rq; },
        async query(text) {
          ran.push(text);
          if (/FROM core\.services/.test(text)) return { recordset: [{ service_id: '44444444-4444-4444-4444-444444444444' }] };
          if (text === PAID_SERVICE_INSERT_SQL && !has041) throw new Error("Invalid column name 'billing_source'.");
          return { rowsAffected: [1] };
        },
      };
      return rq;
    },
  };
}
const T = '11111111-2222-3333-4444-555555555555';

test("with migration 041 the grant is billing_source 'stripe'", async () => {
  const p = pool({ has041: true });
  const r = await enableServiceForTenant(T, 'arion', { platformPool: p });
  assert.equal(r.enabled, true);
  assert.ok(p.ran.includes(PAID_SERVICE_INSERT_SQL));
  assert.ok(!p.ran.includes(PAID_SERVICE_INSERT_LEGACY_SQL));
  assert.match(PAID_SERVICE_INSERT_SQL, /billing_source\) VALUES \(@tid, @sid, 1, 'stripe'\)/);
});

test('without migration 041 the buyer is still granted ARION', async () => {
  const p = pool({ has041: false });
  const r = await enableServiceForTenant(T, 'arion', { platformPool: p });
  assert.equal(r.enabled, true);
  assert.ok(p.ran.includes(PAID_SERVICE_INSERT_LEGACY_SQL), 'the row goes in without the column');
});

test('any other database error is not swallowed', async () => {
  const p = pool({ has041: true });
  const orig = p.request.bind(p);
  p.request = () => { const rq = orig(); const q = rq.query; rq.query = async (t) => { if (t === PAID_SERVICE_INSERT_SQL) throw new Error('deadlock'); return q(t); }; return rq; };
  await assert.rejects(enableServiceForTenant(T, 'arion', { platformPool: p }), /deadlock/);
});
