// ARGUS AI call wrapper — the single entry point for every metered AI call.
//
// Pattern (LOCKED 2026-06-20 per SCOPE_WORKING.md):
//   1. Validate tenant + action_type
//   2. Check current balance, refuse if insufficient
//   3. Load provider key from Key Vault
//   4. Call provider (OpenAI / Anthropic) — caller supplies the actual fetch
//   5. Measure cost_basis_usd from token counts / image counts
//   6. Apply outlier guard ($3 hard cap) — if exceeded, flag the audit row as
//      refunded (credit-neutral in the balance view; NO separate grant row)
//   7. Write lumen.ai_call_audit row
//   8. Debit credits from pool
//   9. Return provider result to caller
//
// Caller responsibilities:
//   - Compute input/output tokens + image_count for cost-basis math
//   - Make the actual provider HTTP call (we don't bind to provider SDKs here
//     so this module stays small + testable)
//
// API:
//   meterAndAudit({ pool, tenantId, userId, actionType, provider, model,
//                   meta, runCall }) → { ok, result, error, audit }
//
// Cost coefficients are conservative — adjust quarterly per scope.

import sql from "mssql";
import { randomUUID } from "node:crypto";
import { argusTables, isArgusSpendEnabled } from "./tables.js";

export { isArgusSpendEnabled };

// Provider cost coefficients (USD per million tokens, USD per image).
// VERIFIED 2026-07-21 against OpenAI model docs + Anthropic pricing (the
// 2026-06-20 table carried stale rates: Haiku 4.5 was 4x UNDERstated at
// $0.25/$1.25 — that's Haiku-3.5 pricing — and Opus 4.7 was 3x OVERstated
// at $15/$75 — that's Opus-4.1-era pricing).
// VERIFIED 2026-08-16 against current Anthropic + OpenAI pricing. Kept in
// lockstep with arion-api/lib/argus/callWrapper.js — these two tables drifted
// once (this file was missing four models the other one priced) and a model
// absent from either records a null cost basis, which silently switches off
// outlier-refund protection.
//   gpt-image-1 medium: $0.042 sq / $0.063 rect - high: $0.167 sq / $0.250 rect
//   (image entries use the WORST size of the tier - conservative fallback;
//   callers that know the size pass costPerImageUsd and win.)
//   Haiku 4.5 $1/$5 - Sonnet 4.6 and Sonnet 5 $3/$15 - Opus 4.7 and 4.8 $5/$25.
//   Sonnet 5 carries promotional pricing of $2/$10 through 2026-08-31; the
//   full rate is used here deliberately so margin is never overstated.
export const PROVIDER_COSTS = {
  "gpt-image-1":       { mode: "image", per_image_usd: 0.063 },
  "gpt-image-1-high":  { mode: "image", per_image_usd: 0.250 },
  "gpt-4o-mini":       { mode: "token", per_million_input_usd: 0.150, per_million_output_usd: 0.600 },
  "gpt-4o":            { mode: "token", per_million_input_usd: 2.500, per_million_output_usd: 10.000 },
  "claude-haiku-4-5":  { mode: "token", per_million_input_usd: 1.000, per_million_output_usd: 5.000 },
  "claude-sonnet-4-6": { mode: "token", per_million_input_usd: 3.000, per_million_output_usd: 15.000 },
  "claude-sonnet-5":   { mode: "token", per_million_input_usd: 3.000, per_million_output_usd: 15.000 },
  "claude-opus-4-7":   { mode: "token", per_million_input_usd: 5.000, per_million_output_usd: 25.000 },
  "claude-opus-4-8":   { mode: "token", per_million_input_usd: 5.000, per_million_output_usd: 25.000 },
};

const OUTLIER_DEFAULT_CAP_USD = 3.0;

/**
 * Compute cost basis from token / image counts.
 */
export function computeCostBasis({ model, inputTokens, outputTokens, imageCount }) {
  const cfg = PROVIDER_COSTS[model];
  if (!cfg) {
    // Loud on purpose. A null cost basis makes `costBasisUsd > outlierCap`
    // false for any spend, so the refund guard quietly stops protecting the
    // client. Silence here is how the drift went unnoticed.
    console.warn(`[argus] NO PRICE for model "${model}" - cost basis null, outlier-refund protection INACTIVE for this call. Add it to PROVIDER_COSTS in BOTH callWrappers.`);
    return null;
  }
  if (cfg.mode === "image") {
    return (imageCount || 0) * cfg.per_image_usd;
  }
  if (cfg.mode === "token") {
    const inUsd = ((inputTokens || 0) / 1_000_000) * cfg.per_million_input_usd;
    const outUsd = ((outputTokens || 0) / 1_000_000) * cfg.per_million_output_usd;
    return inUsd + outUsd;
  }
  return null;
}

/**
 * Load action pricing (credit cost per call + outlier cap).
 */
export async function getActionPricing(pool, actionType) {
  const T = await argusTables(pool);
  const r = await pool.request()
    .input("at", sql.NVarChar(64), actionType)
    .query(`SELECT credits_per_call, outlier_cap_usd, is_active
              FROM ${T.ACTION_PRICING}
             WHERE action_type=@at`);
  return r.recordset[0] || null;
}

/**
 * Current balance for a tenant. Returns 0 if no grants/audit rows.
 * Consolidated: argus.sp_balance (grants − credit_use debits, the meter's
 * model). Legacy: lumen.sp_argus_balance (090 grants − audit rows).
 */
export async function getBalance(pool, tenantId) {
  const T = await argusTables(pool);
  const r = await pool.request()
    .input("tenant_id", sql.UniqueIdentifier, tenantId)
    .execute(T.BALANCE_PROC);
  return r.recordset[0] || { balance: 0, lifetime_granted: 0, lifetime_spent: 0, lifetime_refunded: 0 };
}

/**
 * Insert an audit row + (atomically with same tx ideally, but separate
 * statements are fine here since balance is recomputed as a view).
 */
async function writeAuditRow(pool, {
  callId, tenantId, userId, actionType, provider, model,
  inputTokens, outputTokens, imageCount, costBasisUsd, creditsCharged,
  outlierRefunded, metaJson,
}) {
  const T = await argusTables(pool);
  await pool.request()
    .input("call_id",         sql.UniqueIdentifier, callId || randomUUID())
    .input("tenant_id",       sql.UniqueIdentifier, tenantId)
    .input("user_id",         sql.UniqueIdentifier, userId || null)
    .input("action_type",     sql.NVarChar(64),     actionType)
    .input("provider",        sql.NVarChar(32),     provider)
    .input("model",           sql.NVarChar(64),     model || null)
    .input("input_tokens",    sql.Int,              inputTokens || null)
    .input("output_tokens",   sql.Int,              outputTokens || null)
    .input("image_count",     sql.Int,              imageCount || null)
    .input("cost_basis_usd",  sql.Decimal(10, 6),   costBasisUsd)
    .input("credits_charged", sql.Int,              creditsCharged)
    .input("outlier_refunded", sql.Bit,             outlierRefunded ? 1 : 0)
    .input("meta_json",       sql.NVarChar(sql.MAX), metaJson || null)
    .query(`INSERT INTO ${T.AI_CALL_AUDIT}
              (call_id, tenant_id, user_id, action_type, provider, model,
               input_tokens, output_tokens, image_count, cost_basis_usd,
               credits_charged, outlier_refunded, meta_json)
            VALUES
              (@call_id, @tenant_id, @user_id, @action_type, @provider, @model,
               @input_tokens, @output_tokens, @image_count, @cost_basis_usd,
               @credits_charged, @outlier_refunded, @meta_json)`);
}

/**
 * Main entry point. Caller supplies runCall() which performs the actual
 * provider HTTP call and returns { inputTokens, outputTokens, imageCount,
 * data }. We do the rest.
 */
export async function meterAndAudit({
  pool, tenantId, userId, actionType, provider, model, meta, runCall,
}) {
  // 1. Validate action
  const pricing = await getActionPricing(pool, actionType);
  if (!pricing || !pricing.is_active) {
    return { ok: false, error: { code: "unknown_action", message: `Unknown or disabled action ${actionType}` } };
  }
  const credits = Number(pricing.credits_per_call || 0);
  const outlierCap = Number(pricing.outlier_cap_usd || OUTLIER_DEFAULT_CAP_USD);

  // 2. Check the global kill-switch + balance (skip for actions costing 0 —
  //    like site_initial_build). The FAIL-CLOSED spend gate applies only under
  //    the consolidated schema: it arrived with the 132 consolidation to bring
  //    this wrapper into line with the LUMEN/oliver ones (pre-132 behaviour is
  //    preserved exactly so the legacy fallback mode changes nothing).
  const T = await argusTables(pool);
  if (credits > 0) {
    if (T.consolidated && !(await isArgusSpendEnabled(pool))) {
      return { ok: false, error: { code: "argus_spend_disabled", message: "AI credit spend is currently disabled." } };
    }
    const bal = await getBalance(pool, tenantId);
    if (Number(bal.balance) < credits) {
      return { ok: false, error: { code: "insufficient_credits", message: `Need ${credits} credits, have ${bal.balance}`, balance: bal.balance, required: credits } };
    }
  }

  // 3. Run the actual provider call (caller-supplied)
  const startMs = Date.now();
  let providerResult;
  try {
    providerResult = await runCall();
  } catch (err) {
    // Write audit even on failure — we want to track failed calls for debugging
    await writeAuditRow(pool, {
      callId: undefined, tenantId, userId, actionType, provider, model,
      inputTokens: 0, outputTokens: 0, imageCount: 0,
      costBasisUsd: 0, creditsCharged: 0, outlierRefunded: false,
      metaJson: JSON.stringify({ error: err?.message || "unknown", duration_ms: Date.now() - startMs, ...(meta || {}) }),
    }).catch(() => {}); // never let audit fail the request
    return { ok: false, error: { code: "provider_error", message: err?.message || "Provider call failed" } };
  }
  const { inputTokens = 0, outputTokens = 0, imageCount = 0, data } = providerResult || {};

  // 4. Cost basis
  const costBasisUsd = computeCostBasis({ model, inputTokens, outputTokens, imageCount }) || 0;

  // 5. Outlier guard — if the provider cost blew past the cap, FLAG the call.
  //    The refund is expressed in the audit row ITSELF: we keep
  //    credits_charged = credits (so the founder margin dashboard still sees the
  //    spend) and set outlier_refunded = 1. The balance view nets the two — its
  //    refunded_credits term cancels the charge for flagged rows — so a refunded
  //    call is exactly credit-neutral.
  //
  //    Do NOT zero credits_charged here, and do NOT also mint a separate
  //    lumen.argus_credit_grant refund row: EITHER one turns this single, atomic
  //    reversal into a DOUBLE refund and mints credits (customer ends up richer
  //    for making an expensive call). See test/argus-outlier-refund.test.js.
  let outlierRefunded = false;
  const actualCreditsCharged = credits;
  if (costBasisUsd > outlierCap) {
    outlierRefunded = true;
  }

  // 6. Write audit
  await writeAuditRow(pool, {
    tenantId, userId, actionType, provider, model,
    inputTokens, outputTokens, imageCount,
    costBasisUsd, creditsCharged: actualCreditsCharged,
    outlierRefunded,
    metaJson: JSON.stringify({ duration_ms: Date.now() - startMs, ...(meta || {}) }),
  });

  // 7. Debit the unified ledger (consolidated schema only). Under the
  //    consolidated model balance = grants − argus.credit_use, so a metered
  //    call MUST write a debit row or it spends nothing; an outlier-refunded
  //    call SKIPS the debit — the skip IS the refund (LUMEN wrapper
  //    semantics; never also mint a refund grant, the double-refund trap).
  //    Legacy mode keeps the audit-only 090 model where the balance view
  //    nets refunded audit rows — no debit row exists to write.
  if (T.consolidated && credits > 0 && !outlierRefunded) {
    await pool.request()
      .input("tenantId", sql.UniqueIdentifier, tenantId)
      .input("featureKey", sql.NVarChar(100), actionType)
      .input("credits", sql.Int, credits)
      .input("model", sql.NVarChar(50), model || null)
      .input("costUsd", sql.Decimal(10, 4), costBasisUsd == null ? null : costBasisUsd)
      .query(`INSERT INTO ${T.CREDIT_USE} (tenant_id, feature_key, credits, model, cost_usd)
              VALUES (@tenantId, @featureKey, @credits, @model, @costUsd)`);
  }
  //    (No separate refund grant in either mode — a grant row would
  //    double-count the reversal. Refunds stay visible to the founder via the
  //    margin dashboard (outlier_count + credits_refunded) and the balance
  //    view's lifetime_refunded.)

  return {
    ok: true,
    result: data,
    audit: {
      cost_basis_usd: Number(costBasisUsd.toFixed(6)),
      credits_charged: actualCreditsCharged,
      outlier_refunded: outlierRefunded,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      image_count: imageCount,
    },
  };
}
