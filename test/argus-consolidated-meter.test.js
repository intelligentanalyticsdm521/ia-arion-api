// Pins the migration-132 consolidated behaviour of the arion callWrapper:
// with argus.credit_grant present it (1) enforces the FAIL-CLOSED global
// spend gate (new to this wrapper — parity with LUMEN/oliver), (2) checks
// balance through argus.sp_balance, (3) debits argus.credit_use on success,
// and (4) skips the debit on an outlier refund. Legacy mode is pinned by
// test/argus-outlier-refund.test.js and must stay audit-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { meterAndAudit } from "../lib/argus/callWrapper.js";
import { _resetArgusTablesProbe } from "../lib/argus/tables.js";

const TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function mockPool({ spendEnabled = "true", pricing = { credits_per_call: 4, outlier_cap_usd: 0.5, is_active: true }, balance = 100 } = {}) {
  const ops = { sql: [], uses: [], audits: [] };
  return {
    ops,
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = arguments.length === 2 ? _type : value; return this; },
        async execute(proc) {
          ops.sql.push("EXEC " + proc);
          return { recordset: [{ balance, lifetime_granted: balance, lifetime_spent: 0, lifetime_refunded: 0 }] };
        },
        async query(q) {
          ops.sql.push(q);
          if (q.includes("OBJECT_ID('argus.credit_grant'")) return { recordset: [{ id: 1 }] };
          if (q.includes("platform_config")) return { recordset: spendEnabled == null ? [] : [{ value: spendEnabled }] };
          if (q.includes("action_pricing")) return { recordset: pricing ? [pricing] : [] };
          if (q.includes("INSERT INTO") && q.includes("ai_call_audit")) { ops.audits.push({ ...inputs }); return { recordset: [] }; }
          if (q.includes("INSERT INTO") && q.includes("credit_use")) { ops.uses.push({ ...inputs }); return { recordset: [] }; }
          throw new Error("unexpected query: " + q.slice(0, 60));
        },
      };
    },
  };
}

const okCall = async () => ({ inputTokens: 1000, outputTokens: 500, data: "draft" });

test("arion callWrapper — consolidated mode", async (t) => {
  t.beforeEach(() => _resetArgusTablesProbe());

  await t.test("success: gate checked, balance via argus.sp_balance, argus.* debit written", async () => {
    const pool = mockPool();
    const r = await meterAndAudit({ pool, tenantId: TID, actionType: "x", provider: "anthropic", model: "claude-haiku-4-5", runCall: okCall });
    assert.equal(r.ok, true);
    const all = pool.ops.sql.join("\n");
    assert.match(all, /EXEC argus\.sp_balance/);
    assert.match(all, /FROM argus\.action_pricing/);
    assert.match(all, /INSERT INTO argus\.ai_call_audit/);
    assert.equal(pool.ops.uses.length, 1);
    assert.equal(pool.ops.uses[0].credits, 4);
  });

  await t.test("spend gate not 'true' → argus_spend_disabled, provider never runs", async () => {
    let called = false;
    const pool = mockPool({ spendEnabled: "false" });
    const r = await meterAndAudit({ pool, tenantId: TID, actionType: "x", provider: "anthropic", runCall: async () => { called = true; } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "argus_spend_disabled");
    assert.equal(called, false);
    assert.equal(pool.ops.uses.length, 0);
  });

  await t.test("outlier refund skips the debit (credit-neutral, no refund grant)", async () => {
    const pool = mockPool({ pricing: { credits_per_call: 4, outlier_cap_usd: 0.000001, is_active: true } });
    const r = await meterAndAudit({ pool, tenantId: TID, actionType: "x", provider: "anthropic", model: "claude-haiku-4-5", runCall: okCall });
    assert.equal(r.ok, true);
    assert.equal(r.audit.outlier_refunded, true);
    assert.equal(pool.ops.uses.length, 0);
    assert.equal(pool.ops.audits.length, 1);
    assert.doesNotMatch(pool.ops.sql.join("\n"), /INSERT INTO \S*credit_grant/); // no refund grant minted
  });

  await t.test("zero-credit action: no gate, no balance call, no debit", async () => {
    const pool = mockPool({ pricing: { credits_per_call: 0, outlier_cap_usd: 0.5, is_active: true } });
    const r = await meterAndAudit({ pool, tenantId: TID, actionType: "free", provider: "anthropic", model: "claude-haiku-4-5", runCall: okCall });
    assert.equal(r.ok, true);
    assert.doesNotMatch(pool.ops.sql.join("\n"), /sp_balance|platform_config/);
    assert.equal(pool.ops.uses.length, 0);
  });
});
