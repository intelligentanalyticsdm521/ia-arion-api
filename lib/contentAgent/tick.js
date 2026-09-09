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
// LEARNING FIRST (ARGUS pack 1). Each tenant's style profile is compiled from its
// unconsumed edit/rejection evidence BEFORE anything is drafted, so this week's
// drafts are written with last week's lessons already folded in. Compiling after
// drafting would leave every profile one week behind the evidence that made it.
// It is deterministic and free — no model call, every element traced to a record
// a human's action created (lib/contentAgent/styleCompile.js).
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
import { compileStyleProfile, COMPILE } from './styleCompile.js';

const safeJson = (s, fallback) => { try { return JSON.parse(s ?? ''); } catch { return fallback; } };

/**
 * Enabled, un-halted tenants plus their knobs.
 *
 * `tenantFilter` narrows the SAME query to one business, which is what the
 * Portal's "Run it now" button uses. One code path for a scheduled run and a
 * hand-pressed run so the two cannot drift — and, more importantly, a button on
 * one business's settings page must never run every other business's cycle and
 * spend their money.
 */
export async function loadEnabledTenants(pool, { tenantFilter = null } = {}) {
  const req = pool.request();
  if (tenantFilter) req.input('only', sql.UniqueIdentifier, tenantFilter);
  const r = await req.query(`
    SELECT tenant_id, site_id, slots_per_cycle, content_types, keyword_provider,
           authority_stage, brand_voice, protected_client_names_json,
           approved_client_names_json, competitor_names_json,
           shipped_features_json, halted_at, halted_reason
      FROM arion.content_agent_tenant_config
     WHERE enabled = 1${tenantFilter ? ' AND tenant_id = @only' : ''}`);
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
  // One business only, for the Portal's "Run it now" button. null = the fleet.
  tenantFilter = null,
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

  const configs = await loadEnabledTenants(pool, { tenantFilter });
  const summary = {
    disabled: false,
    tenants: configs.length, ran: 0, skippedHalted: 0, failed: 0,
    results: [], margins: [], alerts: [], notifications: [], learned: [],
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
      // ── LEARN, then write. ──────────────────────────────────────────────
      // Never throws (see styleCompile.js): a tenant whose learning step fails
      // must not cost the drafting cycle that follows it. The outcome is on the
      // summary either way, because "it learned nothing new" and "the learning
      // step broke" are different facts and only one of them needs a person.
      const learned = await compileStyleProfile({
        pool, tenantId, siteId: cfg.site_id ?? null, deps: { log: (m) => log(m) },
      });
      summary.learned.push(learned);
      if (learned.outcome === COMPILE.FAILED) {
        summary.alerts.push({
          tenantId, failure_mode: 'F3', code: 'style_compile_failed',
          message: `The step that folds your edits into what the agent has learned failed (${learned.reason}). Drafts this week were written from the declared brand voice instead.`,
        });
      }

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

  // ONE DIGEST PER BUSINESS, at the end (ARGUS pack 1). Everything above is an
  // exception; this is the ordinary news, and without it a POC reads as "the
  // agents did nothing" because nobody was told to look. It goes out through the
  // same gate and the same identity as every other alert here.
  try {
    for (const cfg of configs) {
      const waiting = await waitingCount(pool, cfg.tenant_id);
      if (waiting > 0) {
        summary.alerts.push({
          tenantId: cfg.tenant_id,
          failure_mode: 'DIGEST',
          code: 'proposals_waiting',
          message: `${waiting} ${waiting === 1 ? 'draft is' : 'drafts are'} waiting for your yes on your website's Agents page. Nothing publishes until you approve it.`,
        });
      }
    }
  } catch (err) {
    log(`digest count failed: ${err.message} — the per-run alerts below are unaffected`);
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

/**
 * How many of this business's drafts are waiting on a person.
 *
 * Escalated units are COUNTED — they are waiting on a human even though they are
 * not approvable from the queue, and a digest that left them out would say
 * "nothing needs you" about the drafts that most need somebody.
 */
async function waitingCount(pool, tenantId) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .query(`SELECT COUNT(*) AS n FROM arion.content_agent_output
             WHERE tenant_id = @t AND review_status IN ('pending','escalated')`);
  return Number(r.recordset[0]?.n || 0);
}

function pick(r) {
  return {
    runId: r.runId, status: r.status, outcome: r.outcome,
    drafted: r.drafted, escalated: r.escalated,
    costUsd: r.costUsd == null ? null : Number(r.costUsd.toFixed(6)),
  };
}

export default { loadEnabledTenants, haltTenant, runTick, waitingCount };
