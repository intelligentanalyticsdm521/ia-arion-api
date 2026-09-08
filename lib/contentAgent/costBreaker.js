// lib/contentAgent/costBreaker.js
//
// Failure mode F8 — "runaway cost (retry storm)". The scope flags this as a GAP:
// "needs a hard per-run cost ceiling / circuit breaker, not yet specified", and
// Open Question Q3 asks Brandon for the number.
//
// Q3 IS STILL OPEN, so this ships with a conservative default and a single place
// to change it (config.js COST). The breaker itself is not optional — a missing
// breaker is what turns a bug into a bill, and F8's "user sees: nothing until log
// review" is the worst row in the failure table precisely because nothing stops it.
//
// THREE LAYERS, because they catch different shapes of runaway:
//
//   per CALL   — lumen.argus_action_pricing.outlier_cap_usd, enforced inside
//                meterAndAudit. Catches one pathological call. Already existed.
//   per RUN    — this module. Catches a retry loop inside a single run.
//   per CYCLE  — this module. Catches "every run is slightly too expensive",
//                which no per-call cap can see.
//
// The per-cycle layer is the one that matters for AC7 ("monthly LLM cost stays
// under $10, confirmed by run-log cost aggregation"), because a per-call cap of
// $0.50 still permits an unbounded number of calls.
//
// HALT IS STICKY. Once a cycle trips, it stays tripped until a human clears it
// (COST.REQUIRES_MANUAL_RESET). An auto-resuming breaker is not a breaker; it
// is a delay. Scope 30.2: "Cost-ceiling breach -> hard stop plus alert."

import sql from 'mssql';
import { COST } from './config.js';

export const BREAKER = {
  OK: 'ok',
  RUN_CEILING: 'run_ceiling_exceeded',
  CYCLE_CEILING: 'cycle_ceiling_exceeded',
};

export class CostCeilingExceeded extends Error {
  constructor(state) {
    super(`[costBreaker] ${state.reason}: spent $${state.spentUsd.toFixed(4)} against a $${state.ceilingUsd.toFixed(2)} ceiling`);
    this.name = 'CostCeilingExceeded';
    this.state = state;
  }
}

/**
 * Per-run accumulator. Constructed once per agent run and consulted before
 * every metered call.
 *
 * Deliberately synchronous and in-memory: a breaker that needs a database round
 * trip to decide whether to stop is a breaker that fails when the database is
 * the thing having a bad day.
 */
export class RunCostBreaker {
  constructor({ maxUsdPerRun = COST.MAX_USD_PER_RUN } = {}) {
    this.maxUsdPerRun = maxUsdPerRun;
    this.spentUsd = 0;
    this.calls = 0;
    this.tripped = false;
  }

  /** Throws BEFORE an expensive call if the run has already tripped. */
  assertCanSpend() {
    if (this.tripped || this.spentUsd >= this.maxUsdPerRun) {
      this.tripped = true;
      throw new CostCeilingExceeded({
        reason: BREAKER.RUN_CEILING,
        spentUsd: this.spentUsd,
        ceilingUsd: this.maxUsdPerRun,
        calls: this.calls,
      });
    }
  }

  /** Record actual spend after a call. Returns the new total. */
  record(costUsd) {
    const c = Number(costUsd) || 0;
    this.spentUsd += c;
    this.calls += 1;
    if (this.spentUsd >= this.maxUsdPerRun) this.tripped = true;
    return this.spentUsd;
  }

  get remainingUsd() {
    return Math.max(0, this.maxUsdPerRun - this.spentUsd);
  }

  status() {
    return {
      spentUsd: Number(this.spentUsd.toFixed(6)),
      ceilingUsd: this.maxUsdPerRun,
      calls: this.calls,
      tripped: this.tripped,
      verdict: this.tripped ? BREAKER.RUN_CEILING : BREAKER.OK,
    };
  }
}

/**
 * Cycle spend for a tenant, read from the run log — the same aggregation AC7 is
 * measured by, so the breaker and the acceptance criterion cannot disagree.
 *
 * Tenant-scoped in SQL.
 */
export async function cycleSpendUsd(pool, tenantId, { sinceDays = 7 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('days', sql.Int, sinceDays)
    .query(`
      SELECT COALESCE(SUM(cost_usd), 0) AS spent
        FROM arion.content_agent_run_log
       WHERE tenant_id = @tenantId
         AND triggered_at >= DATEADD(DAY, -@days, SYSDATETIMEOFFSET())`);
  return Number(r.recordset[0]?.spent || 0);
}

/**
 * Gate a whole cycle before it starts. Call once at run entry.
 *
 * @returns {Promise<{allowed: boolean, verdict: string, spentUsd: number, ceilingUsd: number, message?: string}>}
 */
export async function checkCycleBudget(pool, tenantId, {
  maxUsdPerCycle = COST.MAX_USD_PER_CYCLE, sinceDays = 7,
} = {}) {
  const spentUsd = await cycleSpendUsd(pool, tenantId, { sinceDays });
  if (spentUsd >= maxUsdPerCycle) {
    return {
      allowed: false,
      verdict: BREAKER.CYCLE_CEILING,
      spentUsd,
      ceilingUsd: maxUsdPerCycle,
      message: `Content agent halted: $${spentUsd.toFixed(4)} spent in the last ${sinceDays} days against a $${maxUsdPerCycle.toFixed(2)} cycle ceiling. `
        + (COST.REQUIRES_MANUAL_RESET
          ? 'Requires a manual reset — the agent will not resume on its own.'
          : 'Will resume next cycle.'),
    };
  }
  return { allowed: true, verdict: BREAKER.OK, spentUsd, ceilingUsd: maxUsdPerCycle };
}

/**
 * Wrap a metered call so spend is checked before and recorded after.
 *
 * `meteredCall` must resolve to the meterAndAudit shape:
 *   { ok, result, error, audit: { cost_basis_usd } }
 *
 * A failed call still records its (usually zero) cost — a provider error that
 * costs nothing must not silently reset the breaker's view of the run.
 */
export async function spendGuarded(breaker, meteredCall) {
  breaker.assertCanSpend();
  const res = await meteredCall();
  breaker.record(res?.audit?.cost_basis_usd ?? 0);
  return res;
}

export default {
  BREAKER, CostCeilingExceeded, RunCostBreaker,
  cycleSpendUsd, checkCycleBudget, spendGuarded,
};
