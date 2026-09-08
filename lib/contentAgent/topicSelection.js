// lib/contentAgent/topicSelection.js
//
// Task 2 — keyword research + topic selection.
//
// Turns "what should we write about this week" into a decision with its
// reasoning attached. User story 3: Brandon must be able to see WHY a keyword
// was picked — volume, KD, intent, and which rule fired — so the rationale is
// produced here and stored beside the draft, never reconstructed later.
//
// ORDER OF OPERATIONS, and why it is this order:
//
//   1. dedup against the last 90 days FIRST (AC5, Decision Rule 21.1)
//   2. then qualify on volume / KD / intent (SEO Standards 2-4)
//   3. then check cross-slot overlap within this cycle (edge case E3 — the doc
//      is explicit that overlap is checked BEFORE drafting begins, not after)
//
// Dedup precedes qualification because qualification costs an API call per
// keyword and dedup costs a local index seek. Filtering first is both cheaper
// and the reason the published-slug index exists.

import sql from 'mssql';
import {
  KD_CEILING_BY_STAGE, DEFAULT_AUTHORITY_STAGE, MIN_SEARCH_VOLUME,
  ALLOWED_INTENTS, DEDUP_WINDOW_DAYS, RESEARCH_STALE_AFTER_DAYS,
} from './config.js';
import { HEALTH, researchWithHealth } from './serankingHealth.js';

/** Why a candidate was rejected — surfaced in the rationale, never swallowed. */
export const REJECT = {
  DUPLICATE: 'published_within_dedup_window',
  LOW_VOLUME: 'search_volume_below_minimum',
  KD_TOO_HIGH: 'keyword_difficulty_above_stage_ceiling',
  BAD_INTENT: 'intent_not_servable_by_a_post',
  OVERLAP: 'overlaps_another_slot_this_cycle',
};

/** Outcome kinds. E1 and F1 are DIFFERENT and must never be collapsed. */
export const OUTCOME = {
  SELECTED: 'selected',
  NO_QUALIFYING_TOPIC: 'no_qualifying_topic',   // E1 — correct behaviour, no alert
  PROVIDER_UNAVAILABLE: 'provider_unavailable', // F1 — backlog + ALERT Brandon
};

export function kdCeilingForStage(stage) {
  return KD_CEILING_BY_STAGE[stage] ?? KD_CEILING_BY_STAGE[DEFAULT_AUTHORITY_STAGE];
}

/**
 * Keywords published by THIS tenant inside the dedup window. AC5.
 *
 * Tenant-scoped in the WHERE clause, not filtered afterwards in JS: a query that
 * fetches across tenants and narrows in memory is one forgotten filter away from
 * a cross-tenant leak, and it defeats the index.
 */
export async function recentlyPublishedKeywords(pool, tenantId, { windowDays = DEDUP_WINDOW_DAYS } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('cutoff', sql.Int, windowDays)
    .query(`
      SELECT primary_keyword, url_slug, title, published_at
        FROM arion.content_agent_output
       WHERE tenant_id = @tenantId
         AND published_at IS NOT NULL
         AND published_at >= DATEADD(DAY, -@cutoff, SYSDATETIMEOFFSET())`);
  return r.recordset;
}

/** Normalised for comparison — trailing punctuation and case are not meaning. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Two keywords "collide" if one contains the other as a whole-token run.
 * "emergency plumber" vs "emergency plumber near me" target the same intent and
 * would cannibalise each other, which is the thing Rule 21.1 is protecting
 * against — not merely exact-string repeats.
 */
export function keywordsCollide(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/**
 * What a full-capability provider knows. The default, so SE Ranking semantics
 * (and every original test of them) are unchanged when no capabilities are
 * passed.
 */
export const FULL_CAPABILITIES = { volume: true, kd: true, intent: true };

/**
 * Qualify one candidate against the thresholds. Pure — no I/O — so the rules
 * are testable without a database or a provider.
 *
 * CAPABILITY-AWARE (2026-08-24): SEO tools are optional inputs. A gate only
 * applies when the provider CLAIMS the capability behind it:
 *
 *   * Provider claims KD and the row lacks it     -> reject. Missing data from
 *     a source that should have it means something is broken, and "assume it's
 *     fine" is how an unrankable keyword reaches a draft.
 *   * Provider does not claim KD                  -> the gate is skipped, and
 *     the rationale says so honestly (plus the upsell line). A RankMath or
 *     no-tool tenant still gets an agent; it is just less informed.
 *
 * Dedup is NOT capability-gated. It runs on the tenant's own publish history,
 * which every tenant has, and Rule 21.1 applies to everyone.
 */
export function qualify(candidate, {
  authorityStage = DEFAULT_AUTHORITY_STAGE, publishedKeywords = [],
  capabilities = FULL_CAPABILITIES,
} = {}) {
  const kdCeiling = kdCeilingForStage(authorityStage);

  const dup = publishedKeywords.find((p) => keywordsCollide(candidate.keyword, p.primary_keyword));
  if (dup) {
    return {
      ok: false,
      reason: REJECT.DUPLICATE,
      detail: `collides with "${dup.primary_keyword}" published ${dup.published_at ? new Date(dup.published_at).toISOString().slice(0, 10) : 'recently'}`,
    };
  }

  if (capabilities.volume) {
    const volume = Number(candidate.volume ?? candidate.search_volume ?? 0);
    if (!Number.isFinite(volume) || volume < MIN_SEARCH_VOLUME) {
      return { ok: false, reason: REJECT.LOW_VOLUME, detail: `volume ${volume} < ${MIN_SEARCH_VOLUME}` };
    }
  }

  if (capabilities.kd) {
    const kd = Number(candidate.difficulty ?? candidate.keyword_difficulty ?? NaN);
    // An unknown KD from a provider that should know it is NOT a pass.
    if (!Number.isFinite(kd)) {
      return { ok: false, reason: REJECT.KD_TOO_HIGH, detail: 'keyword difficulty unknown — not assumed passable' };
    }
    if (kd > kdCeiling) {
      return { ok: false, reason: REJECT.KD_TOO_HIGH, detail: `KD ${kd} > ${kdCeiling} ceiling for '${authorityStage}' stage` };
    }
  }

  const intent = String(candidate.intent || '').toLowerCase();
  // Intent absent is tolerated even from SE Ranking — it does not always
  // return it, and rejecting on that would reject nearly everything.
  if (intent && !ALLOWED_INTENTS.includes(intent)) {
    return { ok: false, reason: REJECT.BAD_INTENT, detail: `intent '${intent}' is not servable by a blog post` };
  }

  return { ok: true };
}

/** Human-readable rationale — this is what the reviewer reads to trust the pick.
 *  Honest about what was NOT known: the missing-data line doubles as the
 *  make-your-agent-smarter upsell for tenants without an SEO tool. */
export function buildRationale(candidate, { authorityStage, sourceRule, capabilities = FULL_CAPABILITIES, upsell = null }) {
  const kd = Number(candidate.difficulty ?? candidate.keyword_difficulty ?? NaN);
  const vol = Number(candidate.volume ?? candidate.search_volume ?? 0);
  const parts = [`Selected "${candidate.keyword}".`];

  if (capabilities.volume) {
    parts.push(`Search volume ${vol}/mo (minimum ${MIN_SEARCH_VOLUME}).`);
  }
  if (capabilities.kd && Number.isFinite(kd)) {
    parts.push(`Keyword difficulty ${kd}, within the ${kdCeilingForStage(authorityStage)} ceiling for a '${authorityStage}' domain.`);
  }
  if (!capabilities.volume || !capabilities.kd) {
    parts.push('Search volume and difficulty were not available (no SEO tool connected for this data).');
  }
  if (candidate.rm_seo_score != null) {
    parts.push(`Site already targets this via RankMath (page SEO score ${candidate.rm_seo_score}) — this piece supports that coverage.`);
  }
  parts.push(candidate.intent ? `Intent: ${candidate.intent}.` : 'Intent: not reported by provider.');
  parts.push(`Cleared the ${DEDUP_WINDOW_DAYS}-day dedup check.`);
  if (sourceRule) parts.push(`Source: ${sourceRule}.`);
  if (upsell) parts.push(upsell);
  return parts.join(' ');
}

/**
 * Pull backlog candidates for this tenant. The F1/F6 fallback.
 *
 * Ordered by lowest difficulty first — when the agent is already degraded, the
 * safest substitution is the one most likely to rank.
 */
export async function backlogCandidates(pool, tenantId, { limit = 10 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) candidate_id, keyword, search_volume AS volume,
             keyword_difficulty AS difficulty, intent, source, last_researched_at
        FROM arion.content_keyword_candidate
       WHERE tenant_id = @tenantId
         AND status IN ('candidate','backlog')
       ORDER BY CASE WHEN keyword_difficulty IS NULL THEN 1 ELSE 0 END,
                keyword_difficulty ASC, search_volume DESC`);
  return r.recordset;
}

/** E4 — research older than the threshold is stale and must be re-pulled. */
export function isResearchStale(lastResearchedAt, { staleAfterDays = RESEARCH_STALE_AFTER_DAYS, now = new Date() } = {}) {
  if (!lastResearchedAt) return true;
  const ageMs = now.getTime() - new Date(lastResearchedAt).getTime();
  return ageMs > staleAfterDays * 24 * 60 * 60 * 1000;
}

/**
 * Select topics for one cycle.
 *
 * @param {object}   deps.pool
 * @param {string}   deps.tenantId
 * @param {number}   deps.slots            how many content units this cycle
 * @param {Function} deps.research         () => Promise<Array> — a provider research call
 * @param {string}   [deps.authorityStage]
 * @param {object}   [deps.capabilities]   what the provider knows (FULL_CAPABILITIES default)
 * @param {string}   [deps.sourceLabel]    provider name for the rationale
 * @param {string}   [deps.upsell]         appended to rationales when data was missing
 * @param {boolean}  [deps.healthCheck]    SE Ranking only: disambiguate F1 from E1 via
 *                                         the health probe. RankMath/none read local data,
 *                                         where a failure is a thrown DB error, not an
 *                                         ambiguous empty array — so no probe.
 * @returns {Promise<{outcome, selected: Array, rejected: Array, alert: object|null}>}
 */
export async function selectTopics({
  pool, tenantId, slots = 1, research, authorityStage = DEFAULT_AUTHORITY_STAGE,
  capabilities = FULL_CAPABILITIES, sourceLabel = 'SE Ranking research',
  upsell = null, healthCheck = true,
}) {
  const publishedKeywords = await recentlyPublishedKeywords(pool, tenantId);

  const health = healthCheck
    ? await researchWithHealth(research)
    : await (async () => {
      const rows = await research();
      return { ok: true, rows: Array.isArray(rows) ? rows : [], verdict: HEALTH.HEALTHY, detail: `${(rows || []).length} row(s), local source` };
    })();

  // ---- F1: provider is unhealthy -------------------------------------------
  // Fall back to backlog AND alert. Critically this is NOT reported as "no
  // qualifying topic" — Brandon must see the difference (scope Scenario 3).
  if (!health.ok) {
    const backlog = await backlogCandidates(pool, tenantId, { limit: slots });
    return {
      outcome: OUTCOME.PROVIDER_UNAVAILABLE,
      selected: backlog.slice(0, slots).map((c) => ({
        ...c,
        rationale: `SE Ranking unavailable (${health.verdict}); substituted backlog topic "${c.keyword}" rather than guessing at fresh research.`,
        from_backlog: true,
      })),
      rejected: [],
      alert: {
        failure_mode: 'F1',
        verdict: health.verdict,
        detail: health.detail,
        // Scope 30.2: run failures notify same-day.
        message: `SE Ranking unavailable, ran on backlog. ${health.detail}`,
      },
    };
  }

  // ---- Healthy provider: qualify what came back ----------------------------
  const selected = [];
  const rejected = [];

  for (const candidate of health.rows) {
    if (selected.length >= slots) break;

    const verdict = qualify(candidate, { authorityStage, publishedKeywords, capabilities });
    if (!verdict.ok) {
      rejected.push({ keyword: candidate.keyword, reason: verdict.reason, detail: verdict.detail });
      continue;
    }

    // E3 — overlap within THIS cycle, checked before drafting begins.
    const clash = selected.find((s) => keywordsCollide(s.keyword, candidate.keyword));
    if (clash) {
      rejected.push({
        keyword: candidate.keyword,
        reason: REJECT.OVERLAP,
        detail: `overlaps "${clash.keyword}" already selected for this cycle`,
      });
      continue;
    }

    selected.push({
      ...candidate,
      rationale: buildRationale(candidate, { authorityStage, sourceRule: sourceLabel, capabilities, upsell }),
      from_backlog: false,
    });
  }

  // ---- E1: healthy provider, nothing qualified -----------------------------
  // Log and skip. Do NOT substitute a backlog topic and do NOT alert: the agent
  // declining to force a weak post is it working as designed (scope 12.5).
  if (selected.length === 0) {
    return { outcome: OUTCOME.NO_QUALIFYING_TOPIC, selected: [], rejected, alert: null };
  }

  return { outcome: OUTCOME.SELECTED, selected, rejected, alert: null };
}

export default {
  REJECT, OUTCOME, FULL_CAPABILITIES, kdCeilingForStage, recentlyPublishedKeywords, keywordsCollide,
  qualify, buildRationale, backlogCandidates, isResearchStale, selectTopics,
};
