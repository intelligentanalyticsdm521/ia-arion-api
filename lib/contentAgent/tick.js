// lib/contentAgent/tick.js
//
// Task 8 — the weekly tick. The arion-func timer POSTs
// /internal/content-agent-tick and this is everything behind it (same
// logic-in-the-API / scheduling-in-the-func split as the review replies and the
// social dispatcher).
//
// WHO RUNS (ARGUS employees, phase 1, CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.9):
// every business that has the web person's "Blog posts" or "Social posts" job
// switched ON, read through jobsOn() from the one home of every job's switch
// (iadm_platform core.team_job_setting, written only by platform-api). The old
// arion.content_agent_tenant_config row is no longer the switch: it is now
// optional and holds only agent state (the sticky breaker, the founder's price
// and keyword source, the authority stage, the site). No row = the defaults.
// Content types = the jobs that are on; posts per job = that job's
// posts_per_week.
//
// WE DON'T KNOW = WE DO NOTHING. When the job switches cannot be read, nothing
// runs this tick and the summary says so (console.error names the reason). It
// never reads as "off" and never as "on". That is the opposite direction from
// the ownership check below ("unknown = runs as before"), on purpose: ownership
// decides to DENY, the switch decides to ACT (finding F9; do not "fix" one to
// match the other).
//
// EACH JOB IS GATED BEFORE ANYTHING IS SPENT: its pinned steps must match what
// this runner can do; every check it names must be one this repo can run; its
// required Brief answers must be saved. A job that fails a gate gets one run
// row with the plain sentence and costs nothing.
//
// STICKY F8: when a business's cycle trips the cost ceiling, halted_at is
// written on its agent row (created when it has none; finding F3). The next
// tick skips it and says so. Only a person clearing halted_at resumes it.
//
// FAILURE ISOLATION: one business's failure never costs another's cycle.
//
// LEARNING FIRST (ARGUS pack 1): the style profile is compiled from unconsumed
// edit/rejection evidence BEFORE anything is drafted.
//
// MARGIN: every tick closes with the 60% report (marginMonitor).
//
// KILL SWITCH: CONTENT_AGENT_DISABLED stops the tick BEFORE anything is read.
//
// ALERTS LEAVE THROUGH THE ONE GATE (lib/contentAgent/alerts.js).

import sql from 'mssql';
import { runCycle, recordQuietRun, RUN_STATUS, RUN_FAIL_WORDS } from './runner.js';
import { research as providerResearch, UPSELL_LINE, PROVIDERS, CAPABILITIES } from './keywordProviders.js';
import { marginReport, MARGIN } from './marginMonitor.js';
import { isContentAgentDisabled, KILL_SWITCH_ENV } from './config.js';
import { notifyAlerts } from './alerts.js';
import { compileStyleProfile, COMPILE } from './styleCompile.js';
import { checkOwnership, ownershipSummary } from '../productOwnership.js';
import { jobsOn as seamJobsOn, briefFor as seamBriefFor } from '../teamSeam.js';
import {
  CONTENT_JOBS, CONTENT_TYPE_FOR_JOB, RUN_WORDS, unknownChecksFor,
  conforms, checksFor, lastHold, readsOf, briefValue, briefMeets, briefCitation,
  checkContext, serviceNames, serviceTowns, effectiveMode, approvedInAdvanceWords,
} from '../jobChecks.js';

/** The Brief answers each job needs before it writes a word (§E.5; seeded in 042). */
export const REQUIRED_BRIEF = Object.freeze({
  'arion.blog_posts': ['services|servicesSummary'],
  'arion.social_posts': ['services|servicesSummary'],
});

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/**
 * The OPTIONAL agent rows for these businesses: agent state only (the breaker,
 * the founder's keyword source, the authority stage, the site). Never a switch.
 * @returns {Promise<Map<TENANT_UPPER, row>>}
 */
export async function loadAgentRows(pool, tenantIds) {
  if (!tenantIds.length) return new Map();
  const req = pool.request();
  const names = tenantIds.map((id, i) => { req.input(`t${i}`, sql.UniqueIdentifier, id); return `@t${i}`; });
  const r = await req.query(`
    SELECT tenant_id, site_id, keyword_provider, authority_stage, halted_at, halted_reason
      FROM arion.content_agent_tenant_config
     WHERE tenant_id IN (${names.join(', ')})`);
  return new Map((r.recordset || []).map((row) => [String(row.tenant_id).toUpperCase(), row]));
}

/**
 * Sticky halt write — cleared only by a person. A MERGE, so a breaker trips
 * even for a business with no agent row (finding F3): an UPDATE alone wrote
 * nothing once the row stopped being required to run.
 */
export async function haltTenant(pool, tenantId, reason) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('reason', sql.NVarChar(400), String(reason).slice(0, 400))
    .query(`
      MERGE arion.content_agent_tenant_config AS tgt
      USING (SELECT @tenantId AS tenant_id) AS src ON tgt.tenant_id = src.tenant_id
      WHEN MATCHED AND tgt.halted_at IS NULL THEN
        UPDATE SET halted_at = SYSDATETIMEOFFSET(), halted_reason = @reason, updated_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN
        INSERT (tenant_id, halted_at, halted_reason) VALUES (@tenantId, SYSDATETIMEOFFSET(), @reason);`);
}

/**
 * Gate one job before anything is spent (§D.7 rules 1 and 3, §E.5).
 * @returns {{ ok: true, names } | { ok: false, status, rule, words, outcome }}
 */
export function gateJob(jobKey, jobState, brief) {
  const def = jobState?.playbook?.def;
  if (!conforms(def, jobKey)) {
    return { ok: false, status: RUN_STATUS.FAILED, rule: 'steps_mismatch', words: RUN_WORDS.STEPS_MISMATCH, outcome: 'failed' };
  }
  const names = checksFor(def, jobKey);
  // Known means THIS job's runner runs it (§D.7 rule 3), never "some runner has it".
  const unknown = unknownChecksFor(jobKey, names);
  if (unknown.length) {
    return { ok: false, status: RUN_STATUS.FAILED, rule: 'unknown_check', words: RUN_WORDS.unknownCheck(unknown[0]), outcome: 'failed' };
  }
  if (!briefMeets(brief, REQUIRED_BRIEF[jobKey] || [])) {
    return { ok: false, status: RUN_STATUS.COMPLETED, rule: 'waiting_for_brief', words: RUN_WORDS.WAITING_FOR_SERVICES, outcome: 'blocked' };
  }
  return { ok: true, names };
}

/**
 * The drafting inputs from the Brief: only fields the playbook reads AND the
 * business has saved (§D.7 rule 5). The check lists are not optional: a check
 * reads what it needs whatever the playbook lists.
 */
export function briefInputs(brief, reads) {
  const pick = (api) => (reads.includes(api) ? briefValue(brief, api) : null);
  const ctx = checkContext(brief);
  return {
    brandVoice: pick('brandVoice'),
    whatWeSell: reads.includes('services') ? serviceNames(brief) : [],
    whereWeWork: reads.includes('serviceArea') ? serviceTowns(brief) : [],
    approvedOffers: reads.includes('offersAllowed') ? ctx.approvedOffers : [],
    approvedProof: reads.includes('proofAllowed') ? ctx.approvedProof : [],
    doNotSay: pick('doNotSay'),
    noGoList: pick('noGoList'),
  };
}

/**
 * Run one tick.
 *
 * @param {object}   deps.pool
 * @param {Function} [deps.cycle]      injectable runCycle for tests
 * @param {Function} [deps.doResearch] injectable provider research for tests
 * @param {Function} [deps.jobsOn]     "which jobs are on?" (default: the platform read)
 * @param {Function} [deps.briefFor]   "what does the Brief say?" (default: platform-api)
 * @param {string[]} [deps.jobKeys]    run-now names one job; the timer runs both
 */
export async function runTick({
  pool, log = () => {},
  cycle = runCycle, doResearch = providerResearch,
  notify = notifyAlerts, env = process.env,
  // One business only, for "Run it now". null = the fleet.
  tenantFilter = null,
  ownership = checkOwnership,
  // A provider stand-in for dev exercises only, null in every real tick.
  callImpl = null,
  jobKeys = CONTENT_JOBS,
  jobsOn = seamJobsOn,
  briefFor = seamBriefFor,
  triggerSource = 'timer',
}) {
  const empty = (extra) => ({
    disabled: false, tenants: 0, ran: 0, skippedHalted: 0, failed: 0,
    results: [], margins: [], alerts: [], notifications: [], learned: [],
    productOff: { skipped: [] }, ...extra,
  });

  // Gate 0 — the kill switch, before anything is read or spent.
  if (isContentAgentDisabled(env)) {
    log(`${KILL_SWITCH_ENV} is set — no tenant is run, nothing is drafted, nothing is queued`);
    return { ...empty({ disabled: true, killSwitch: KILL_SWITCH_ENV }), productOff: undefined };
  }

  // Gate 1 — which businesses have which job on. Unreadable = nothing runs.
  const state = await jobsOn([...jobKeys], tenantFilter ? { tenantId: tenantFilter } : {});
  if (!state || state.ok !== true || !(state.on instanceof Map)) {
    const why = state?.error || 'no answer';
    console.error(`[content-agent] ${RUN_WORDS.JOB_STATE_UNREADABLE} (${why})`);
    return empty({ jobStateUnreadable: true, words: RUN_WORDS.JOB_STATE_UNREADABLE, error: why });
  }
  const only = tenantFilter ? String(tenantFilter).toUpperCase() : null;
  const onByTenant = new Map();
  for (const [t, jobs] of state.on) {
    const T = String(t).toUpperCase();
    if (only && T !== only) continue;
    const mine = jobKeys.filter((k) => jobs instanceof Map && jobs.has(k));
    if (mine.length) onByTenant.set(T, mine.map((k) => ({ key: k, state: jobs.get(k) })));
  }
  const tenantIds = [...onByTenant.keys()];

  // Access follows the subscription (scope 2026-10-07 §4.3). Unknown = runs as before.
  const verdict = await ownership('arion', tenantIds);
  const runFor = new Set(verdict.owned.map((id) => String(id).toUpperCase()));
  const agentRows = await loadAgentRows(pool, tenantIds.filter((t) => runFor.has(t)));
  const summary = empty({
    tenants: tenantIds.filter((t) => runFor.has(t)).length,
    productOff: ownershipSummary(verdict, "the web person didn't write anything"),
  });
  for (const s of summary.productOff.skipped) log(`business ${s.tenantId}: skipped — ${s.note}`);

  const ran = [];
  for (const T of tenantIds) {
    if (!runFor.has(T)) continue;
    const jobs = onByTenant.get(T);
    const tenantId = jobs[0]?.state?.tenantId || T;
    const cfg = agentRows.get(T) || {};

    if (cfg.halted_at) {
      summary.skippedHalted += 1;
      summary.results.push({ tenantId, status: 'skipped_halted', reason: cfg.halted_reason });
      log(`tenant ${tenantId}: skipped (halted since ${cfg.halted_at}: ${cfg.halted_reason})`);
      continue;
    }

    try {
      // The Brief, saved answers only. Unreadable = this business does nothing this tick.
      const read = await briefFor(tenantId);
      if (!read || read.ok !== true || !read.brief) {
        console.error(`[content-agent] tenant ${tenantId}: ${RUN_WORDS.BRIEF_UNREADABLE} (${read?.error || 'no answer'})`);
        for (const job of jobs) {
          await recordQuietRun(pool, {
            tenantId, siteId: cfg.site_id ?? null, triggerSource, jobKey: job.key,
            playbookVersion: job.state?.playbook?.version ?? null,
            status: RUN_STATUS.FAILED, rule: 'brief_unreadable', words: RUN_WORDS.BRIEF_UNREADABLE,
          });
          summary.results.push({ tenantId, jobKey: job.key, status: 'skipped', outcome: 'failed', words: RUN_WORDS.BRIEF_UNREADABLE });
        }
        continue;
      }
      const brief = read.brief;

      // Each job's gates, before anything is spent.
      const ready = [];
      for (const job of jobs) {
        const gate = gateJob(job.key, job.state, brief);
        if (!gate.ok) {
          await recordQuietRun(pool, {
            tenantId, siteId: cfg.site_id ?? null, triggerSource, jobKey: job.key,
            playbookVersion: job.state?.playbook?.version ?? null,
            status: gate.status, rule: gate.rule, words: gate.words,
          });
          summary.results.push({ tenantId, jobKey: job.key, status: gate.status, outcome: gate.outcome, words: gate.words });
          log(`tenant ${tenantId} ${job.key}: ${gate.words}`);
          continue;
        }
        ready.push({ ...job, names: gate.names });
      }
      if (!ready.length) continue;
      ran.push(tenantId);

      // ── LEARN, then write (never throws; see styleCompile.js). ────────────
      const learned = await compileStyleProfile({
        pool, tenantId, siteId: cfg.site_id ?? null, deps: { log: (m) => log(m) },
      });
      summary.learned.push(learned);
      if (learned.outcome === COMPILE.FAILED) {
        // The reason is the exception: the log has it, the owner reads a sentence.
        console.warn(`[content-agent] tenant ${tenantId}: rule=style_compile_failed detail=${learned.reason}`);
        summary.alerts.push({
          tenantId, failure_mode: 'F3', code: 'style_compile_failed',
          message: STYLE_COMPILE_FAILED_WORDS,
        });
      }

      // Research once per business: the service names, the towns it works in,
      // and the topics the owner asked the jobs to lean towards.
      const seedTopics = ready.flatMap((j) => (Array.isArray(j.state?.vars?.seed_topics) ? j.state.vars.seed_topics : []));
      const seeds = [...new Set([...serviceNames(brief), ...serviceTowns(brief), ...seedTopics].map(String).filter(Boolean))];
      const provided = await doResearch(pool, tenantId, { configured: cfg.keyword_provider || 'auto', seeds });
      const isSeRanking = provided.provider === PROVIDERS.SE_RANKING;

      for (const job of ready) {
        const contentType = CONTENT_TYPE_FOR_JOB[job.key];
        const def = job.state.playbook.def;
        const reads = readsOf(def);
        const inputs = briefInputs(brief, reads);
        const ctx = checkContext(brief, { shippedFeatures: serviceNames(brief) });
        const automatic = effectiveMode(job.state) === 'automatic' && lastHold(def) === 'by_mode';
        const result = await cycle({
          pool,
          ...(callImpl ? { callImpl } : {}),
          tenantId,
          siteId: cfg.site_id ?? null,
          slots: clampInt(job.state?.vars?.posts_per_week, 1, 7, 1),
          triggerSource,
          research: async () => provided.rows,
          authorityStage: cfg.authority_stage || 'new',
          brandVoice: inputs.brandVoice,
          contentType,
          capabilities: provided.capabilities || CAPABILITIES[provided.provider],
          sourceLabel: `${provided.capabilities?.label || provided.provider} (${provided.detail})`,
          upsell: isSeRanking ? null : UPSELL_LINE,
          healthCheck: isSeRanking,
          protectedClientNames: ctx.namesNeverMention,
          approvedClientNames: ctx.namesYouMayMention,
          competitorNames: ctx.competitors,
          shippedFeatures: ctx.shippedFeatures,
          render: null,
          jobKey: job.key,
          playbookVersion: job.state.playbook.version ?? null,
          checkNames: job.names,
          checkCtx: ctx,
          briefCited: briefCitation(brief, reads),
          brief: inputs,
          automaticBy: automatic ? approvedInAdvanceWords(job.state) : null,
          holdReason: lastHold(def) === 'always' ? 'always_asks' : 'send_me_first',
          postTime: job.state?.vars?.post_time || '10:00',
        });

        summary.ran += 1;
        summary.results.push({ tenantId, jobKey: job.key, contentType, provider: provided.provider, ...pick(result) });
        summary.alerts.push(...(result.alerts || []).map((a) => ({ tenantId, ...a })));

        // Sticky F8: a cost-ceiling outcome halts the BUSINESS, not just the run.
        if (result.outcome === 'cost_ceiling'
          || (result.alerts || []).some((a) => a.failure_mode === 'F8')) {
          const why = (result.alerts || []).find((a) => a.failure_mode === 'F8')?.message || 'cost ceiling';
          await haltTenant(pool, tenantId, why);
          summary.results.push({ tenantId, status: 'halted_sticky', reason: why });
          log(`tenant ${tenantId}: HALTED (sticky) — ${why}`);
          break;
        }
        log(runLogLine(tenantId, job.key, result));
      }
    } catch (err) {
      // The owner's answer carries the plain sentence; the exception is logged.
      summary.failed += 1;
      summary.results.push({ tenantId, status: 'tick_error', outcome: 'failed', words: RUN_FAIL_WORDS.stopped });
      console.warn(`[content-agent] tenant ${tenantId}: rule=tick_error status=failed detail=${err.message}`);
      log(`tenant ${tenantId}: tick error — ${err.message}`);
    }
  }

  // The 60% report closes every FLEET tick. Breaches surface as alerts.
  // Never on "Run it now" (tenantFilter): that answer goes to one business's
  // owner, and the report holds every other business's price and spend.
  if (!tenantFilter) try {
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

  // ONE DIGEST PER BUSINESS, at the end (ARGUS pack 1).
  try {
    for (const tenantId of ran) {
      const waiting = await waitingCount(pool, tenantId);
      if (waiting > 0) {
        summary.alerts.push({
          tenantId,
          failure_mode: 'DIGEST',
          code: 'proposals_waiting',
          message: `${waiting} ${waiting === 1 ? 'draft is' : 'drafts are'} waiting for you in ARGUS → Your team → The web person → Needs you. Nothing goes out until you approve it, unless you set that job to Automatic.`,
        });
      }
    }
  } catch (err) {
    log(`digest count failed: ${err.message} — the per-run alerts below are unaffected`);
  }

  try {
    summary.notifications = await notify({ alerts: summary.alerts, log });
  } catch (err) {
    log(`alert dispatch failed: ${err.message} — alerts remain in the summary and the run log`);
  }

  return summary;
}

/**
 * How many of this business's drafts are waiting on a person (escalated ones
 * are counted: they are waiting on a person more than any).
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
    drafted: r.drafted, escalated: r.escalated, approvedInAdvance: r.approvedInAdvance || 0,
    // How many pieces it tried and how many of those failed (a run where every
    // one failed is status 'failed'; the Portal's runResult says so in rose).
    ...(r.attempted == null ? {} : { attempted: r.attempted }),
    ...(r.failed == null ? {} : { failed: r.failed }),
    ...(typeof r.words === 'string' && r.words ? { words: r.words } : {}),
    costUsd: r.costUsd == null ? null : Number(r.costUsd.toFixed(6)),
  };
}

/** What the owner reads when the step that learns from their edits fails. */
export const STYLE_COMPILE_FAILED_WORDS = "The step that learns from your edits didn't work this time, so this week's drafts were written from your business details instead.";

/**
 * The one log line per run. A failure is grep-able: the status is said, and
 * failed=N (with attempted=N) is there whenever any piece failed.
 */
export function runLogLine(tenantId, jobKey, result) {
  const failed = Number(result?.failed) || 0;
  const tail = failed > 0 ? ` attempted=${Number(result?.attempted) || 0} failed=${failed}` : '';
  return `tenant ${tenantId} ${jobKey}: ${result?.status} drafted=${result?.drafted} escalated=${result?.escalated}${tail} $${(result?.costUsd || 0).toFixed(4)}`;
}

export default { REQUIRED_BRIEF, STYLE_COMPILE_FAILED_WORDS, loadAgentRows, haltTenant, gateJob, briefInputs, runTick, runLogLine, waitingCount };
