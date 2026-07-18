// test/argus-outlier-refund.test.js
//
// Pins the ARGUS outlier-refund credit-MINTING bug. This is a MONEY path in the
// wrong direction: it handed customers FREE credits.
//
// WHAT WAS WRONG (callWrapper.js meterAndAudit, outlier path):
//   On an outlier call (provider cost > cap) the code did BOTH halves of a
//   refund at once:
//     1. wrote the audit row with credits_charged = 0   (a refund), AND
//     2. INSERTed a +credits row into lumen.argus_credit_grant (a second refund).
//   The balance view is  active_grants - SUM(credits_charged)
//                                      + SUM(credits_charged WHERE outlier_refunded=1).
//   With credits_charged already 0, zeroing it IS the refund; the extra grant
//   row was a SECOND refund. Net: an outlier call left the tenant with
//   prev + credits  — richer for making an expensive call — and they kept the
//   result. Every outlier was a margin loss AND a credit giveaway.
//
//   Second face: the view's refunded_credits term
//     SUM(CASE WHEN outlier_refunded=1 THEN credits_charged ELSE 0 END)
//   is structurally DEAD when credits_charged is always 0 in that case, so
//   lifetime_refunded (and the founder margin dashboard) reported 0 forever.
//
// THE FIX (audit-only, single atomic write):
//   Keep credits_charged = credits and set outlier_refunded = 1; write NO grant
//   row. The view then nets the charge against its own refunded_credits term
//   (credits - credits = 0) so the call is exactly credit-neutral, and
//   refunded_credits comes alive because credits_charged is now the real value.
//
// THE INVARIANT THIS TEST GUARDS:
//   Balance after an outlier call is FLAT (equal to before) — never higher.
//   A normal call debits exactly `credits`. No lumen.argus_credit_grant row is
//   ever written by the wrapper.

import test from "node:test";
import assert from "node:assert/strict";

import { meterAndAudit } from "../lib/argus/callWrapper.js";

// ─────────────────────────────────────────────────────────────────────────────
// A fake mssql pool that records every statement + its bound inputs, and
// answers the two reads meterAndAudit makes (pricing + balance).
// ─────────────────────────────────────────────────────────────────────────────
function makePool({ pricing, startingBalance }) {
  const ops = [];
  const pool = {
    ops,
    request() {
      const inputs = {};
      const builder = {
        input(name, _type, value) { inputs[name] = value; return builder; },
        async query(text) {
          ops.push({ kind: "query", text, inputs });
          if (/FROM lumen\.argus_action_pricing/i.test(text)) return { recordset: [pricing] };
          return { recordset: [] }; // INSERTs (audit / — post-fix — never a grant)
        },
        async execute(proc) {
          ops.push({ kind: "execute", proc, inputs });
          if (proc === "lumen.sp_argus_balance") {
            return { recordset: [{ balance: startingBalance, lifetime_granted: startingBalance, lifetime_spent: 0, lifetime_refunded: 0 }] };
          }
          return { recordset: [] };
        },
      };
      return builder;
    },
  };
  return pool;
}

// Faithful mirror of the lumen.argus_credit_balance view (migration 090):
//   balance = active_grants
//           - SUM(credits_charged)
//           + SUM(credits_charged WHERE outlier_refunded = 1)
// Fed the writes the wrapper actually performed, so any drift (a zeroed charge,
// a stray grant row) shows up as a non-flat balance — exactly how the bug bit.
function balanceFromView(ops, startingActiveGrants) {
  let active = startingActiveGrants, spent = 0, refunded = 0;
  for (const op of ops) {
    if (op.kind !== "query") continue;
    if (/INSERT INTO lumen\.argus_credit_grant/i.test(op.text)) {
      active += Number(op.inputs.credits || 0);
    }
    if (/INSERT INTO lumen\.ai_call_audit/i.test(op.text)) {
      const charged = Number(op.inputs.credits_charged || 0);
      spent += charged;
      if (op.inputs.outlier_refunded === 1 || op.inputs.outlier_refunded === true) refunded += charged;
    }
  }
  return active - spent + refunded;
}

const auditInserts = (ops) => ops.filter((o) => o.kind === "query" && /INSERT INTO lumen\.ai_call_audit/i.test(o.text));
const grantInserts = (ops) => ops.filter((o) => o.kind === "query" && /INSERT INTO lumen\.argus_credit_grant/i.test(o.text));

const PRICING = { credits_per_call: 15, outlier_cap_usd: 3.0, is_active: 1 };
const START = 1000; // pre-existing active grants → starting balance

const base = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  actionType: "variant_explore",
  provider: "anthropic",
  meta: {},
};

// ─────────────────────────────────────────────────────────────────────────────

test("normal call (under cap): debits exactly `credits`, writes no grant row", async () => {
  const pool = makePool({ pricing: PRICING, startingBalance: START });
  const before = balanceFromView(pool.ops, START);

  // claude-haiku-4-5 on ~1k/1k tokens ≈ $0.0015 — well under the $3 cap.
  const res = await meterAndAudit({
    ...base, pool, model: "claude-haiku-4-5",
    runCall: async () => ({ inputTokens: 1000, outputTokens: 1000, imageCount: 0, data: { ok: true } }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.audit.outlier_refunded, false);
  assert.equal(res.audit.credits_charged, 15);
  assert.equal(auditInserts(pool.ops).length, 1);
  assert.equal(grantInserts(pool.ops).length, 0, "wrapper must never write a grant row");

  const after = balanceFromView(pool.ops, START);
  assert.equal(after, before - 15, "a normal call debits exactly `credits`");
});

test("outlier call (over cap): balance is FLAT, not higher — no credit minting", async () => {
  const pool = makePool({ pricing: PRICING, startingBalance: START });
  const before = balanceFromView(pool.ops, START);

  // claude-opus-4-7 emitting 1,000,000 output tokens ≈ $75 — 25× over the cap.
  const res = await meterAndAudit({
    ...base, pool, model: "claude-opus-4-7",
    runCall: async () => ({ inputTokens: 0, outputTokens: 1_000_000, imageCount: 0, data: { ok: true } }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.audit.outlier_refunded, true);

  // The refund lives in the audit row: charge stays visible, flag flips.
  assert.equal(res.audit.credits_charged, 15, "credits_charged must NOT be zeroed (spend stays visible)");

  // Exactly one audit row and — the crux — ZERO grant rows. A second refund
  // channel is what minted credits.
  assert.equal(auditInserts(pool.ops).length, 1);
  assert.equal(grantInserts(pool.ops).length, 0, "an outlier must not mint a refund grant row");

  const after = balanceFromView(pool.ops, START);
  assert.equal(after, before, "outlier balance must be FLAT (before === after)");
  assert.ok(after <= before, "an outlier must never leave the tenant with MORE credits");
});
