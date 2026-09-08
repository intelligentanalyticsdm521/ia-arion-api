// lib/contentAgent/runner.js
//
// The orchestrator — one cycle, end to end.
//
// This is what the iadm-webhooks-prod timer will call (Task 8). It is written as
// a plain async function rather than an Azure Function so the whole cycle is
// testable and runnable by hand; the timer binding is a thin wrapper over it.
//
// AC6 GOVERNS THE SHAPE: "every run — successful, failed, or escalated — is
// logged with cost, tokens, and status." So the run row is INSERTED FIRST, in
// status 'running', before any work happens, and updated on every exit path
// including the throwing ones.
//
// That ordering is deliberate. The platform's recurring bug is an error caught,
// swallowed, and reported as success; the mirror-image bug is a crash that
// leaves no trace at all. A row that exists from t=0 cannot be lost by a
// failure, so "what happened last Tuesday" always has an answer.
//
// ORDER OF GATES, cheapest and most-likely-to-stop-us first:
//   1. cycle cost breaker  — a halted tenant does no work at all (F8)
//   2. topic selection     — may return E1 (skip) or F1 (backlog + alert)
//   3. draft + guardrails  — per unit; escalation withholds, it does not fail
//   4. persist             — every unit, escalated or not
//
// Publication is NOT part of a run. AC8 requires an explicit human approval
// between drafting and scheduling, so the runner stops at 'pending'.

import sql from 'mssql';
import { MODELS } from './config.js';
import { RunCostBreaker, CostCeilingExceeded, checkCycleBudget } from './costBreaker.js';
import { selectTopics, OUTCOME } from './topicSelection.js';
import { draftContentUnit, saveOutput, DraftingError } from './drafting.js';
import { loadActiveProfile } from './styleProfile.js';

export const RUN_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ESCALATED: 'escalated',
};

const AGENT_NAME = 'arion.content_agent';
const AGENT_VERSION = 'v0.2';

async function openRun(pool, { tenantId, siteId = null, triggerSource = 'timer' }) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('name', sql.NVarChar(128), AGENT_NAME)
    .input('version', sql.NVarChar(40), AGENT_VERSION)
    .input('trigger', sql.NVarChar(40), triggerSource)
    .input('model', sql.NVarChar(128), MODELS.DRAFT)
    .query(`
      INSERT INTO arion.content_agent_run_log
        (tenant_id, site_id, agent_name, agent_version, trigger_source, status, model_version)
      OUTPUT INSERTED.run_id
      VALUES (@tenantId, @siteId, @name, @version, @trigger, 'running', @model)`);
  return r.recordset[0].run_id;
}

async function closeRun(pool, runId, { status, breaker, flags = [], errorDetail = null, tokensIn = 0, tokensOut = 0 }) {
  await pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .input('status', sql.NVarChar(20), status)
    .input('cost', sql.Decimal(10, 6), breaker ? Number(breaker.spentUsd.toFixed(6)) : 0)
    .input('tin', sql.Int, tokensIn)
    .input('tout', sql.Int, tokensOut)
    // Always an array, never null, on a finished run — "no flags" and "flags
    // were never evaluated" must not look identical in the log.
    .input('flags', sql.NVarChar(sql.MAX), JSON.stringify(flags || []))
    .input('err', sql.NVarChar(sql.MAX), errorDetail)
    .query(`
      UPDATE arion.content_agent_run_log
         SET status = @status, completed_at = SYSDATETIMEOFFSET(),
             cost_usd = @cost, tokens_in = @tin, tokens_out = @tout,
             decision_rule_flags_json = @flags, error_detail = @err
       WHERE run_id = @runId`);
}

/**
 * Run one content cycle for one tenant.
 *
 * Never throws for an expected condition — E1, F1, F8 and provider failures all
 * resolve to a recorded run plus a structured result. It throws only if the run
 * log itself cannot be written, because at that point nothing can be trusted.
 *
 * @returns {Promise<{runId, status, outcome, drafted, escalated, alerts, costUsd}>}
 */
export async function runCycle({
  pool, tenantId, siteId = null, slots = 1, triggerSource = 'timer',
  research, authorityStage, brandVoice = null, contentType = 'blog_post',
  protectedClientNames = [], approvedClientNames = [], competitorNames = [],
  shippedFeatures = [], userId = null,
  // Provider awareness (2026-08-24): SEO tools are optional inputs. The
  // capabilities object gates which qualification rules apply; healthCheck is
  // true only for SE Ranking, whose failures hide inside empty arrays — local
  // sources (RankMath/none) throw real errors instead.
  capabilities, sourceLabel, upsell = null, healthCheck = true,
  // Carousel rendering (Task 5) — injectable so tests never need chromium.
  // null = rendering not attempted (blog-only cycles).
  render = null,
  // Provider stand-in, in the same spirit as `render` and `research`: null in
  // every real run, so drafting.js uses callClaude and the default cannot
  // drift. It exists so a dev exercise can drive the REAL pipeline against the
  // REAL database - meter, breaker, guardrails, persistence - with no network
  // call and no money. Never set in production.
  callImpl = null,
}) {
  // Gate 1 — a halted tenant does no work and opens no run.
  const budget = await checkCycleBudget(pool, tenantId);
  if (!budget.allowed) {
    return {
      runId: null,
      status: 'halted',
      outcome: 'cost_ceiling',
      drafted: 0,
      escalated: 0,
      costUsd: budget.spentUsd,
      alerts: [{ failure_mode: 'F8', code: budget.verdict, message: budget.message }],
    };
  }

  const runId = await openRun(pool, { tenantId, siteId, triggerSource });
  const breaker = new RunCostBreaker();
  const alerts = [];
  const flags = [];
  let drafted = 0;
  let escalatedCount = 0;

  try {
    // Gate 2 — topics.
    const topics = await selectTopics({
      pool, tenantId, slots, research, authorityStage,
      ...(capabilities ? { capabilities } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      upsell, healthCheck,
    });
    if (topics.alert) alerts.push(topics.alert);

    if (topics.outcome === OUTCOME.NO_QUALIFYING_TOPIC) {
      // E1 — this is the agent working correctly, so the run COMPLETED.
      // Marking it failed would train Brandon to ignore failures.
      await closeRun(pool, runId, {
        status: RUN_STATUS.COMPLETED, breaker,
        flags: [{ rule: 'no_qualifying_topic', detail: `${topics.rejected.length} candidate(s) rejected` }],
      });
      return {
        runId, status: RUN_STATUS.COMPLETED, outcome: OUTCOME.NO_QUALIFYING_TOPIC,
        drafted: 0, escalated: 0, costUsd: breaker.spentUsd, alerts, rejected: topics.rejected,
      };
    }

    const styleProfile = await loadActiveProfile(pool, tenantId);

    // Gate 3 — draft each selected topic.
    for (const topic of topics.selected) {
      let unit;
      try {
        unit = await draftContentUnit({
          pool, tenantId, userId, topic, styleProfile, contentType, brandVoice,
          shippedFeatures, protectedClientNames, approvedClientNames, competitorNames, breaker,
          ...(callImpl ? { callImpl } : {}),
        });
      } catch (err) {
        if (err instanceof CostCeilingExceeded) throw err;   // stop the whole run
        if (err instanceof DraftingError) {
          // One unit failed. Record it and carry on with the others — a single
          // bad keyword must not cost the whole cycle. Nothing is queued for it.
          alerts.push({
            failure_mode: err.code === 'keyword_placement' ? 'F4' : 'F2',
            code: err.code,
            message: `Slot for "${topic.keyword}" produced no draft: ${err.message}. ${err.detail || ''}`.trim(),
          });
          flags.push({ rule: 'slot_skipped', keyword: topic.keyword, detail: err.code });
          continue;
        }
        throw err;
      }

      const outputId = await saveOutput(pool, {
        runId, tenantId, siteId, contentType, topic,
        draft: unit.draft, guardrails: unit.guardrails,
        styleProfileId: styleProfile?.styleId || null,
      });
      drafted += 1;

      // Task 5 — render carousel slides for social units. BEST-EFFORT: a
      // failed render is F7 (flag for manual rendering), never a failed run.
      // A missing image is a visible gap in the queue; a failed run is a
      // missing week.
      if (render && contentType === 'social_carousel' && !unit.escalated) {
        try {
          const rendered = await render({
            tenantId, outputId, draft: unit.draft,
            tokens: styleProfile?.brandTokens || {},
          });
          if (rendered?.assetPaths?.length) {
            await pool.request()
              .input('tenantId', sql.UniqueIdentifier, tenantId)
              .input('id', sql.UniqueIdentifier, outputId)
              .input('uri', sql.NVarChar(1000), rendered.assetPaths.join(','))
              .query('UPDATE arion.content_agent_output SET asset_uri = @uri WHERE tenant_id = @tenantId AND output_id = @id');
          }
        } catch (err) {
          alerts.push({
            failure_mode: 'F7',
            code: err.code || 'render_failed',
            message: `Carousel for "${topic.keyword}" could not be rendered (${String(err.message).slice(0, 160)}). The copy is in the queue; render the slides manually.`,
          });
          flags.push({ rule: 'render_manual_fallback', keyword: topic.keyword, output_id: outputId });
        }
      }

      if (unit.escalated) {
        escalatedCount += 1;
        flags.push(...unit.guardrails.flags.map((f) => ({ ...f, output_id: outputId })));
        // Scope 30.2 — escalation notifies immediately, not batched.
        alerts.push({
          failure_mode: 'F3',
          code: 'escalation',
          immediate: true,
          message: `Content unit for "${topic.keyword}" tripped an escalation rule and was withheld from the queue: ${unit.guardrails.flags.map((f) => f.rule).join(', ')}`,
        });
      }
    }

    const status = escalatedCount > 0 ? RUN_STATUS.ESCALATED : RUN_STATUS.COMPLETED;
    await closeRun(pool, runId, { status, breaker, flags });
    return {
      runId, status, outcome: topics.outcome, drafted, escalated: escalatedCount,
      costUsd: breaker.spentUsd, alerts,
    };
  } catch (err) {
    const isCost = err instanceof CostCeilingExceeded;
    await closeRun(pool, runId, {
      status: RUN_STATUS.FAILED, breaker, flags,
      errorDetail: `${err.name}: ${err.message}${err.detail ? ` | ${err.detail}` : ''}`,
    }).catch(() => { /* the run row is best-effort at this point; do not mask the original error */ });

    alerts.push({
      failure_mode: isCost ? 'F8' : 'F2',
      code: isCost ? 'cost_ceiling' : (err.code || 'run_failed'),
      message: isCost
        ? `Run halted on the per-run cost ceiling after $${breaker.spentUsd.toFixed(4)}. Nothing was queued.`
        : `Run failed: ${err.message}. Nothing partial was queued.`,
    });

    return {
      runId, status: RUN_STATUS.FAILED, outcome: 'failed',
      drafted, escalated: escalatedCount, costUsd: breaker.spentUsd, alerts,
    };
  }
}

export default { RUN_STATUS, runCycle };
