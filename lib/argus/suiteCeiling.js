// lib/argus/suiteCeiling.js — THE suite-wide cost ceiling, and the only
// place that decides whether an agent run may open.
//
// ═══ WHY THIS FILE EXISTS ══════════════════════════════════════════════════
//
// Before it, there were two competing mechanisms for "how much may an agent
// spend", and neither of them worked:
//
//   1. `argus.governance_cost_config` held a ceiling and a warn ratio, and
//      `lib/governance/rules.js:158 costSummary()` computed a verdict of
//      ok / warn / breached — which NOTHING read before a run. `breached`
//      halted nothing. It was a number on a report.
//
//   2. Each agent carried its per-run and per-cycle ceilings as HARD-CODED
//      module constants — `lib/qtcAgent/config.js:18-22`,
//      `LUMEN src/lib/campaignAgent/config.js:21-24`,
//      `arion lib/contentAgent/config.js` — not per tenant, not editable, not
//      visible on any screen.
//
// Decision, 2026-09-08 (adopted): `argus.governance_cost_config` is THE ceiling
// home. It is enforced in every runner, it is editable founder-only, and each
// agent keeps its own per-run breaker as the INNER ring. Two rings, one home
// for the number.
//
// ═══ WHERE THE SPEND NUMBER COMES FROM, AND WHY NOT THE RUN INDEX ══════════
//
// `costSummary()` sums `argus.governance_run_index`, which is a DERIVED copy
// filled by the governance reindex. Enforcing a ceiling off a derived copy means
// the ceiling is only as current as the last reindex — and until this pack the
// reindex had no scheduler at all, so the number was permanently zero.
//
// This file sums `argus.ai_call_audit.cost_basis_usd` instead. That table gets a
// row from `meterAndAudit` on EVERY model call in every repo, including provider
// failures and outlier refunds — it is the platform's authoritative spend record
// and it is correct the instant a call is made. The CEILING still comes from the
// governance table; only the MEASUREMENT comes from the audit. One home for the
// number, one home for the spend.
//
// It is filtered to AGENT_ACTIONS. A business that generates a lot of images in
// Design Studio must not have its follow-up agent halted by its own image bill —
// those are different budgets and the ceiling is named for the agent suite.
//
// ═══ FAIL DIRECTION, STATED OUT LOUD ══════════════════════════════════════
//
// A ceiling we cannot READ is not a ceiling of zero, and it is not a ceiling of
// infinity either. It is an unknown, and this returns `ceiling_unreadable` with
// `allowed: true` — deliberately:
//
//   · The inner ring is untouched. Every agent still has its per-run and
//     per-cycle breaker and its sticky halt, so an unreadable OUTER ring cannot
//     produce a runaway; it can only fail to catch a slow suite-wide drift.
//   · Halting every agent on every business the moment a permission is missing
//     is the exact failure the S-6 grant gap would cause in production TODAY:
//     on SCHEMA::argus only app-arion-api-prod holds anything. A whole suite
//     going silent for a GRANT is worse than a suite running on its inner ring.
//   · It is never swallowed. The verdict is returned, written to the run's
//     decision flags, and raised as an alert, so "we could not check" reaches a
//     human instead of reading as "we checked and it was fine".
//
// A MISSING ROW is different from an unreadable table and says so:
// `no_ceiling_configured`, allowed, flagged. Migration 204 seeds a row for every
// business that has an agent, so this should be rare and worth noticing.
//
// ═══ THREE COPIES, ON PURPOSE, AND A TEST THAT KEEPS THEM HONEST ═══════════
//
// This module is a copy of `oliver-api/lib/governance/suiteCeiling.js`, which is
// the origin; LUMEN holds the CJS twin at `src/lib/argus/suiteCeiling.js`.
// Three copies because the three agents run in three
// deployments and there is no shared package. That is the same arrangement the
// notification-gate client already lives in across five repos. Each repo's test
// asserts the CONTRACT — same table names, same action list, same verdict words,
// same thresholds — so the copies cannot drift silently. If they ever drift,
// three tests go red at once.

import sql from "mssql";

/**
 * Every action an ARGUS AGENT spends on. Not every AI action on the platform:
 * the assist tools (write-assist, image generate, review reply) are a different
 * budget and are deliberately absent.
 *
 * Field Ops has no entry because its scorer is fully deterministic — zero
 * marginal cost is a feature of that agent, not an omission here.
 */
export const AGENT_ACTIONS = Object.freeze([
  "arion.content_draft",
  "arion.social_copy",
  "arion.content_quality_scan",
  "arion.topic_selection",
  "spark.campaign_agent_draft",
  "spark.campaign_agent_scan",
  "spark.responder_classify",
  "spark.responder_draft",
  "spark.responder_quote_draft",
  "oliver.qtc_agent_draft",
]);

/** The two tables, named once. */
export const CEILING_TABLE = "argus.governance_cost_config";
export const SPEND_TABLE = "argus.ai_call_audit";

export const VERDICT = Object.freeze({
  OK: "ok",
  WARN: "warn",
  BREACHED: "breached",
  NO_CEILING: "no_ceiling_configured",
  NOT_ENFORCED: "not_enforced",
  UNREADABLE: "ceiling_unreadable",
});

/** Default window. A monthly ceiling measured over 30 rolling days. */
export const DEFAULT_PERIOD_DAYS = 30;

/**
 * The verdict rule. PURE — this is the half the contract test compares across
 * the three repos, and the half that needs no database to exercise.
 */
export function verdictFor({ totalUsd, ceilingUsd, warnRatio, enforced }) {
  const total = Number(totalUsd) || 0;
  const ceiling = ceilingUsd == null ? null : Number(ceilingUsd);
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) {
    return { verdict: VERDICT.NO_CEILING, allowed: true, ratio: null, totalUsd: total, ceilingUsd: null };
  }
  const ratio = Math.round((total / ceiling) * 10000) / 10000;
  if (enforced === false) {
    return { verdict: VERDICT.NOT_ENFORCED, allowed: true, ratio, totalUsd: total, ceilingUsd: ceiling };
  }
  const warn = Number.isFinite(Number(warnRatio)) ? Number(warnRatio) : 0.75;
  if (ratio >= 1) return { verdict: VERDICT.BREACHED, allowed: false, ratio, totalUsd: total, ceilingUsd: ceiling };
  if (ratio >= warn) return { verdict: VERDICT.WARN, allowed: true, ratio, totalUsd: total, ceilingUsd: ceiling };
  return { verdict: VERDICT.OK, allowed: true, ratio, totalUsd: total, ceilingUsd: ceiling };
}

/** The sentence a run flag, an alert and an API response all share. */
export function ceilingMessage(v, tenantId) {
  switch (v.verdict) {
    case VERDICT.BREACHED:
      return `The agent suite has spent $${v.totalUsd.toFixed(4)} of its $${v.ceilingUsd.toFixed(2)} monthly ceiling for this business. Runs are halted until the ceiling is raised or the month rolls over.`;
    case VERDICT.WARN:
      return `The agent suite has spent $${v.totalUsd.toFixed(4)} of its $${v.ceilingUsd.toFixed(2)} monthly ceiling (${Math.round(v.ratio * 100)}%). Still running.`;
    case VERDICT.NO_CEILING:
      return `No suite spend ceiling is configured for ${tenantId}. Each agent's own per-run breaker is the only limit.`;
    case VERDICT.NOT_ENFORCED:
      return `A suite ceiling of $${v.ceilingUsd.toFixed(2)} exists but enforcement is switched off. Nothing is being capped.`;
    case VERDICT.UNREADABLE:
      return `The suite spend ceiling could not be read (${v.reason}). Each agent's own per-run breaker still applies; the suite-wide limit is NOT being checked.`;
    default:
      return `Suite spend $${v.totalUsd.toFixed(4)}.`;
  }
}

/** The ceiling row for one business, or null when it has none. */
export async function loadCeiling(pool, tenantId) {
  const r = await pool.request()
    .input("tenantId", sql.NVarChar(100), String(tenantId).toLowerCase())
    .query(`
      SELECT suite_monthly_ceiling_usd, warn_ratio, per_agent_ceiling_usd, enforced,
             breached_at, breached_reason
        FROM ${CEILING_TABLE}
       WHERE LOWER(tenant_id) = @tenantId`);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    ceilingUsd: row.suite_monthly_ceiling_usd == null ? null : Number(row.suite_monthly_ceiling_usd),
    warnRatio: row.warn_ratio == null ? 0.75 : Number(row.warn_ratio),
    perAgentCeilingUsd: row.per_agent_ceiling_usd == null ? null : Number(row.per_agent_ceiling_usd),
    // `enforced` predates nothing — migration 204 added it with DEFAULT 1, and a
    // database that has not applied 204 yet reads undefined, which must mean ON.
    enforced: row.enforced === undefined ? true : !!row.enforced,
    breachedAt: row.breached_at || null,
    breachedReason: row.breached_reason || null,
  };
}

/** Agent spend for one business over the window, from the authoritative audit. */
export async function suiteSpendUsd(pool, tenantId, { periodDays = DEFAULT_PERIOD_DAYS } = {}) {
  const req = pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("days", sql.Int, periodDays);
  const names = AGENT_ACTIONS.map((a, i) => { req.input(`a${i}`, sql.NVarChar(64), a); return `@a${i}`; });
  const r = await req.query(`
    SELECT COALESCE(SUM(cost_basis_usd), 0) AS cost_usd, COUNT(*) AS calls
      FROM ${SPEND_TABLE}
     WHERE tenant_id = @tenantId
       AND action_type IN (${names.join(",")})
       AND created_at >= DATEADD(DAY, -@days, SYSUTCDATETIME())`);
  const row = r.recordset[0] || {};
  return { totalUsd: Number(row.cost_usd || 0), calls: Number(row.calls || 0) };
}

/**
 * THE call every runner makes before it opens a run.
 *
 * Never throws. A failure to read is a named verdict, not an exception into a
 * runner that would then report a failed run for a reason that has nothing to do
 * with the work.
 *
 * @returns {Promise<{verdict, allowed, totalUsd, ceilingUsd, ratio, perAgentCeilingUsd, message, reason?}>}
 */
export async function suiteCeilingCheck(pool, tenantId, { periodDays = DEFAULT_PERIOD_DAYS } = {}) {
  let cfg = null;
  try {
    cfg = await loadCeiling(pool, tenantId);
  } catch (err) {
    const v = { verdict: VERDICT.UNREADABLE, allowed: true, totalUsd: 0, ceilingUsd: null, ratio: null, reason: err.message };
    return { ...v, perAgentCeilingUsd: null, message: ceilingMessage(v, tenantId) };
  }
  if (!cfg) {
    const v = { verdict: VERDICT.NO_CEILING, allowed: true, totalUsd: 0, ceilingUsd: null, ratio: null };
    return { ...v, perAgentCeilingUsd: null, message: ceilingMessage(v, tenantId) };
  }

  let spend;
  try {
    spend = await suiteSpendUsd(pool, tenantId, { periodDays });
  } catch (err) {
    const v = { verdict: VERDICT.UNREADABLE, allowed: true, totalUsd: 0, ceilingUsd: cfg.ceilingUsd, ratio: null, reason: err.message };
    return { ...v, perAgentCeilingUsd: cfg.perAgentCeilingUsd, message: ceilingMessage(v, tenantId) };
  }

  const v = verdictFor({
    totalUsd: spend.totalUsd, ceilingUsd: cfg.ceilingUsd,
    warnRatio: cfg.warnRatio, enforced: cfg.enforced,
  });
  return {
    ...v,
    calls: spend.calls,
    perAgentCeilingUsd: cfg.perAgentCeilingUsd,
    periodDays,
    message: ceilingMessage(v, tenantId),
  };
}

/** Record the breach on the ceiling row so the founder card can show WHEN. */
export async function markCeilingBreached(pool, tenantId, reason) {
  await pool.request()
    .input("tenantId", sql.NVarChar(100), String(tenantId).toLowerCase())
    .input("reason", sql.NVarChar(400), String(reason).slice(0, 400))
    .query(`
      UPDATE ${CEILING_TABLE}
         SET breached_at = SYSDATETIMEOFFSET(), breached_reason = @reason,
             updated_at = SYSDATETIMEOFFSET()
       WHERE LOWER(tenant_id) = @tenantId AND breached_at IS NULL`);
}

export default {
  AGENT_ACTIONS, CEILING_TABLE, SPEND_TABLE, VERDICT, DEFAULT_PERIOD_DAYS,
  verdictFor, ceilingMessage, loadCeiling, suiteSpendUsd, suiteCeilingCheck,
  markCeilingBreached,
};
