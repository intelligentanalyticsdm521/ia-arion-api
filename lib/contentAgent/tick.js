// lib/contentAgent/tick.js
//
// Task 8 — the weekly tick. The arion-func timer POSTs
// /internal/content-agent-tick and this is everything behind it (same
// logic-in-the-API / scheduling-in-the-func split as gbpAutoReply and the
// social dispatcher).
//
// WHO RUNS: every tenant with a row in arion.content_agent_tenant_config where
// enabled = 1 and halted_at IS NULL. No row, no run, no cost — enablement is a
// signup action, not a default.
//
// STICKY F8: when a tenant's cycle trips the cost ceiling, halted_at is written
// on their config row. The next tick skips them and says so. Only a human
// clearing halted_at resumes the agent — an auto-resuming breaker is a delay,
// not a breaker.
//
// FAILURE ISOLATION: one tenant's failure must never cost another tenant's
// cycle, so each tenant is wrapped separately and the summary reports per-tenant
// outcomes. The tick itself only throws if the config table cannot be read.
//
// MARGIN: every tick closes with the 60% report (marginMonitor). A breach does
// not stop anything — it is a pricing alarm for the founder, surfaced in the
// summary and the alerts list.
//
// KILL SWITCH: CONTENT_AGENT_DISABLED stops the tick BEFORE the config table is
// read. Nothing is queued, nothing is metered, no tenant row is touched — the
// summary says disabled and the caller can prove it by the absence of any
// query. Scope 35's rollback plan is this one variable.
//
// ALERTS LEAVE THROUGH THE ONE GATE: the summary's alerts are the machine
// record; lib/contentAgent/alerts.js is what tells a human, and it asks
// platform-api's preference gate with a category_key first and takes every
// business name from the one business identity. A gate that cannot decide HOLDS
// the alert — nothing is sent on an unknown answer.

import sql from 'mssql';
import { runCycle } from './runner.js';
import { research as providerResearch, UPSELL_LINE, PROVIDERS, CAPABILITIES } from './keywordProviders.js';
import { marginReport, MARGIN } from './marginMonitor.js';
import { renderCarousel } from './carouselRenderer.js';
import { isContentAgentDisabled, KILL_SWITCH_ENV } from './config.js';
import { notifyAlerts } from './alerts.js';

const safeJson = (s, fallback) => { try { return JSON.parse(s ?? ''); } catch { return fallback; } };

/** Enabled, un-halted tenants plus their knobs. */
export async function loadEnabledTenants(pool) {
  const r = await pool.request().query(`
    SELECT tenant_id, site_id, slots_per_cycle, content_types, keyword_provider,
           authority_stage, brand_voice, protected_client_names_json,
           approved_client_names_json, competitor_names_json,
           shipped_features_json, halted_at, halted_reason
      FROM arion.content_agent_tenant_config
     WHERE enabled = 1`);
  return r.recordset;
}

/** Sticky halt write — cleared only by a human editing the config row. */
export async function haltTenant(pool, tenantId, reason) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('reason', sql.NVarChar(400), String(reason).slice(0, 400))
    .query(`
      UPDATE arion.content_agent_tenant_config
         SET halted_at = SYSDATETIMEOFFSET(), halted_reason = @reason,
             updated_at = SYSDATETIMEOFFSET()
       WHERE tenant_id = @tenantId AND halted_at IS NULL`);
}

/**
 * Run one tick across all enabled tenants.
 *
 * @param {object} deps.pool
 * @param {Function} [deps.cycle]     injectable runCycle for tests
 * @param {Function} [deps.doResearch] injectable provider research for tests
 * @param {Function} [deps.render]     injectable renderer for tests
 * @returns {Promise<{tenants, ran, skippedHalted, failed, margins, alerts}>}
 */
export async function runTick({
  pool, log = () => {},
  cycle = runCycle, doResearch = providerResearch, render = renderCarousel,
  notify = notifyAlerts, env = process.env,
  // See runner.js: a provider stand-in for dev exercises only, null in every
  // real tick.
  callImpl = null,
}) {
  // Gate 0 — the kill switch, before anything is read or spent.
  if (isContentAgentDisabled(env)) {
    log(`${KILL_SWITCH_ENV} is set — no tenant is run, nothing is drafted, nothing is queued`);
    return {
      disabled: true, killSwitch: KILL_SWITCH_ENV,
      tenants: 0, ran: 0, skippedHalted: 0, failed: 0,
      results: [], margins: [], alerts: [], notifications: [],
    };
  }

  const configs = await loadEnabledTenants(pool);
  const summary = {
    disabled: false,
    tenants: configs.length, ran: 0, skippedHalted: 0, failed: 0,
    results: [], margins: [], alerts: [], notifications: [],
  };

  for (const cfg of configs) {
    const tenantId = cfg.tenant_id;

    if (cfg.halted_at) {
      summary.skippedHalted += 1;
      summary.results.push({ tenantId, status: 'skipped_halted', reason: cfg.halted_reason });
      log(`tenant ${tenantId}: skipped (halted since ${cfg.halted_at}: ${cfg.halted_reason})`);
      continue;
    }

    try {
      // Resolve this tenant's keyword provider and pull candidates ONCE, so the
      // runner's research closure is provider-shaped and F1 semantics only apply
      // where they exist (SE Ranking).
      const seeds = safeJson(cfg.shipped_features_json, []); // business-context seeds fall back to shipped features/topics
      const provided = await doResearch(pool, tenantId, {
        configured: cfg.keyword_provider || 'auto',
        seeds,
      });
      const isSeRanking = provided.provider === PROVIDERS.SE_RANKING;

      const contentTypes = String(cfg.content_types || 'blog_post').split(',').map((s) => s.trim()).filter(Boolean);

      for (const contentType of contentTypes) {
        const result = await cycle({
          pool,
          ...(callImpl ? { callImpl } : {}),
          tenantId,
          siteId: cfg.site_id,
          slots: Number(cfg.slots_per_cycle) || 1,
          triggerSource: 'timer',
          research: async () => provided.rows,
          authorityStage: cfg.authority_stage || 'new',
          brandVoice: cfg.brand_voice,
          contentType,
          capabilities: provided.capabilities || CAPABILITIES[provided.provider],
          sourceLabel: `${provided.capabilities?.label || provided.provider} (${provided.detail})`,
          upsell: isSeRanking ? null : UPSELL_LINE,
          healthCheck: isSeRanking,
          protectedClientNames: safeJson(cfg.protected_client_names_json, []),
          approvedClientNames: safeJson(cfg.approved_client_names_json, []),
          competitorNames: safeJson(cfg.competitor_names_json, []),
          shippedFeatures: safeJson(cfg.shipped_features_json, []),
          render: contentType === 'social_carousel' ? render : null,
        });

        summary.ran += 1;
        summary.results.push({ tenantId, contentType, provider: provided.provider, ...pick(result) });
        summary.alerts.push(...(result.alerts || []).map((a) => ({ tenantId, ...a })));

        // Sticky F8: a cost-ceiling outcome halts the TENANT, not just the run.
        if (result.outcome === 'cost_ceiling'
          || (result.alerts || []).some((a) => a.failure_mode === 'F8')) {
          const why = (result.alerts || []).find((a) => a.failure_mode === 'F8')?.message || 'cost ceiling';
          await haltTenant(pool, tenantId, why);
          summary.results.push({ tenantId, status: 'halted_sticky', reason: why });
          log(`tenant ${tenantId}: HALTED (sticky) — ${why}`);
          break; // no further content types for this tenant
        }
        log(`tenant ${tenantId} ${contentType}: ${result.status} drafted=${result.drafted} escalated=${result.escalated} $${(result.costUsd || 0).toFixed(4)}`);
      }
    } catch (err) {
      // One tenant's failure never costs another tenant's cycle.
      summary.failed += 1;
      summary.results.push({ tenantId, status: 'tick_error', error: String(err.message).slice(0, 300) });
      log(`tenant ${tenantId}: tick error — ${err.message}`);
    }
  }

  // The 60% report closes every tick. Breaches surface as alerts.
  try {
    summary.margins = await marginReport(pool);
    for (const m of summary.margins) {
      if (m.verdict === MARGIN.BREACH) {
        summary.alerts.push({
          tenantId: m.tenantId,
          failure_mode: 'MARGIN',
          code: MARGIN.BREACH,
          message: `Tenant ${m.tenantId}: agent cost is ${(m.ratio * 100).toFixed(1)}% of their $${m.priceUsdMonthly}/mo price — over the 60% line. Rethink pricing.`,
        });
      }
    }
  } catch (err) {
    log(`margin report failed: ${err.message}`);
  }

  // Tell a human. Every message asks the ONE preference gate with a
  // category_key and is named by the ONE business identity; a gate that cannot
  // decide HOLDS the alert rather than sending it. Best-effort by contract — a
  // failed alert must not cost the cycle that produced it, and the alerts are
  // already recorded in the summary and the run log either way.
  try {
    summary.notifications = await notify({ alerts: summary.alerts, log });
  } catch (err) {
    log(`alert dispatch failed: ${err.message} — alerts remain in the summary and the run log`);
  }

  return summary;
}

function pick(r) {
  return {
    runId: r.runId, status: r.status, outcome: r.outcome,
    drafted: r.drafted, escalated: r.escalated,
    costUsd: r.costUsd == null ? null : Number(r.costUsd.toFixed(6)),
  };
}

export default { loadEnabledTenants, haltTenant, runTick };
