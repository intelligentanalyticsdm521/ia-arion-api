// lib/contentAgent/marginMonitor.js
//
// The 60% rule. Brandon 2026-08-24: "make sure that we are not reaching 60%
// spend on those and if we are then we need to seriously rethink pricing."
//
// Meaning: for each tenant, the LLM cost of running their agent must stay under
// 60% of what they PAY for the agent. This is a margin alarm, not a breaker —
// crossing it does not halt the agent (the cost breaker in costBreaker.js does
// halting); it tells the founder the pricing is wrong before the P&L does.
//
// TWO DELIBERATE CHOICES:
//
// 1. The denominator comes from arion.content_agent_tenant_config
//    .price_usd_monthly — configuration, never code. The standing
//    no-fabricated-catalog rule: prices live in config/Stripe, and a hardcoded
//    default price here would quietly become the real price. NULL price =
//    verdict 'price_not_set', which is itself a finding worth surfacing.
//
// 2. The numerator is the run log's cost_usd aggregation — the SAME source AC7
//    is measured by, so the margin alarm and the acceptance criterion cannot
//    disagree about what a month cost.

import sql from 'mssql';

/** Cost may not exceed this fraction of the price the tenant pays. */
export const MAX_COST_TO_PRICE_RATIO = 0.60;

/** Warn early: at 45% the trend is visible before the line is crossed. */
export const WARN_COST_TO_PRICE_RATIO = 0.45;

export const MARGIN = {
  OK: 'ok',
  WARN: 'approaching_ceiling',
  BREACH: 'cost_exceeds_60pct_of_price',
  PRICE_NOT_SET: 'price_not_set',
};

/**
 * Margin check for one tenant over a trailing window.
 *
 * @returns {Promise<{verdict, costUsd, priceUsdMonthly, ratio, windowDays, message}>}
 */
export async function checkMargin(pool, tenantId, { windowDays = 30 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('days', sql.Int, windowDays)
    .query(`
      SELECT
        (SELECT COALESCE(SUM(cost_usd), 0)
           FROM arion.content_agent_run_log
          WHERE tenant_id = @tenantId
            AND triggered_at >= DATEADD(DAY, -@days, SYSDATETIMEOFFSET())) AS cost_usd,
        (SELECT price_usd_monthly
           FROM arion.content_agent_tenant_config
          WHERE tenant_id = @tenantId) AS price_usd_monthly`);

  const row = r.recordset[0] || {};
  const costUsd = Number(row.cost_usd || 0);
  const price = row.price_usd_monthly == null ? null : Number(row.price_usd_monthly);

  if (price == null || price <= 0) {
    return {
      verdict: MARGIN.PRICE_NOT_SET,
      costUsd,
      priceUsdMonthly: price,
      ratio: null,
      windowDays,
      message: `Agent cost $${costUsd.toFixed(4)} over ${windowDays}d, but no price is configured for this tenant — the 60% margin rule cannot be evaluated. Set price_usd_monthly on the tenant's agent config.`,
    };
  }

  // Normalise the window to a month so a 7-day check compares fairly.
  const monthlyCost = costUsd * (30 / windowDays);
  const ratio = monthlyCost / price;

  let verdict = MARGIN.OK;
  if (ratio >= MAX_COST_TO_PRICE_RATIO) verdict = MARGIN.BREACH;
  else if (ratio >= WARN_COST_TO_PRICE_RATIO) verdict = MARGIN.WARN;

  const pct = (ratio * 100).toFixed(1);
  return {
    verdict,
    costUsd,
    monthlyCostUsd: Number(monthlyCost.toFixed(4)),
    priceUsdMonthly: price,
    ratio: Number(ratio.toFixed(4)),
    windowDays,
    message: verdict === MARGIN.BREACH
      ? `MARGIN BREACH: agent cost is ${pct}% of the $${price}/mo price (limit ${MAX_COST_TO_PRICE_RATIO * 100}%). Rethink pricing or usage for this tenant.`
      : verdict === MARGIN.WARN
        ? `Margin warning: agent cost is ${pct}% of the $${price}/mo price and trending toward the ${MAX_COST_TO_PRICE_RATIO * 100}% ceiling.`
        : `Margin healthy: agent cost is ${pct}% of the $${price}/mo price.`,
  };
}

/**
 * Founder view: every priced or running business's margin in one pass, worst first.
 * This is the "seriously rethink pricing" screen.
 */
export async function marginReport(pool, { windowDays = 30 } = {}) {
  const r = await pool.request()
    .input('days', sql.Int, windowDays)
    .query(`
      SELECT c.tenant_id, c.price_usd_monthly,
             COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM arion.content_agent_tenant_config c
        LEFT JOIN arion.content_agent_run_log l
          ON l.tenant_id = c.tenant_id
         AND l.triggered_at >= DATEADD(DAY, -@days, SYSDATETIMEOFFSET())
       GROUP BY c.tenant_id, c.price_usd_monthly
      -- ARGUS employees phase 1: the on/off is the job's now (core.team_job_setting,
      -- another database), so "who to report" is every business with a price set
      -- or a run in the window — the ones whose margin means something.
      HAVING c.price_usd_monthly IS NOT NULL OR COUNT(l.run_id) > 0`);

  const rows = r.recordset.map((row) => {
    const cost = Number(row.cost_usd || 0);
    const monthly = cost * (30 / windowDays);
    const price = row.price_usd_monthly == null ? null : Number(row.price_usd_monthly);
    const ratio = price && price > 0 ? monthly / price : null;
    return {
      tenantId: row.tenant_id,
      costUsd: Number(cost.toFixed(4)),
      monthlyCostUsd: Number(monthly.toFixed(4)),
      priceUsdMonthly: price,
      ratio: ratio == null ? null : Number(ratio.toFixed(4)),
      verdict: ratio == null ? MARGIN.PRICE_NOT_SET
        : ratio >= MAX_COST_TO_PRICE_RATIO ? MARGIN.BREACH
          : ratio >= WARN_COST_TO_PRICE_RATIO ? MARGIN.WARN : MARGIN.OK,
    };
  });

  // Worst margin first; unpriced tenants at the top because they are unmeasurable.
  rows.sort((a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity));
  return rows;
}

export default { MAX_COST_TO_PRICE_RATIO, WARN_COST_TO_PRICE_RATIO, MARGIN, checkMargin, marginReport };
