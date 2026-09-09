// lib/contentAgent/keywordCandidates.js — the Keyword Tracker as a table that
// something actually writes to.
//
// ═══ THE GAP ═══════════════════════════════════════════════════════════════
//
// `arion.content_keyword_candidate` had no INSERT, no status update and no
// `last_researched_at` write ANYWHERE in the repo. Consequences, all real:
//
//   · Every SE Ranking (or RankMath) research result was used once and thrown
//     away, so the same API call was paid for again next week.
//   · The BACKLOG the agent falls back to when the SEO tool is down (failure
//     mode F1) and when a topic was already published inside the 90-day dedup
//     window (F6) only ever contained what a human had typed in by hand — two
//     rows on dev. So the documented fallback had almost nothing to fall back to.
//   · `status` never moved to in_progress or published, so edge case E4's
//     staleness re-pull had nothing to read and the tracker could not tell you
//     which keywords you had already covered.
//   · `UX_content_keyword_candidate_kw` (Decision Rule 21.1) was a uniqueness
//     guarantee on a table nothing filled.
//
// ═══ WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT ════════════════
//
// It PERSISTS what research returned and it MOVES a candidate's status as the
// agent works on it. It does not select topics — `topicSelection.js` owns that,
// and a second selector would be a second answer to "what should we write about".
//
// IDEMPOTENT BY THE DATABASE, not by a pre-SELECT. `UX_content_keyword_candidate_kw`
// on (tenant_id, keyword) is the guarantee; this MERGEs against it, so two ticks
// racing on the same keyword produce one row and not a duplicate-key 500. That is
// the sanctioned pattern: let the unique index be the arbiter.
//
// A REFRESH NEVER DOWNGRADES A STATUS. Research that comes back for a keyword
// already marked `published` updates its volume and difficulty and leaves the
// status alone — otherwise every week's research would reset the tracker's memory
// of what has been written, which is the one thing it exists to remember.

import sql from 'mssql';

/** The status vocabulary migration 063's CHECK constraint allows. */
export const CANDIDATE_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  BACKLOG: 'backlog',
  IN_PROGRESS: 'in_progress',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
});

/** Statuses that record work already done. Research must not walk them back. */
const TERMINAL_ISH = [CANDIDATE_STATUS.IN_PROGRESS, CANDIDATE_STATUS.PUBLISHED, CANDIDATE_STATUS.REJECTED];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fail closed: a tenant-scoped write without a real tenant is a leak waiting. */
function assertTenant(tenantId) {
  if (!tenantId || typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) {
    throw new Error(`[keywordCandidates] refusing to write without a valid tenant scope (got ${JSON.stringify(tenantId)})`);
  }
  return tenantId;
}

/**
 * Persist one research pass.
 *
 * @param {object} p
 * @param {import('mssql').ConnectionPool} p.pool
 * @param {string} p.tenantId
 * @param {string|null} [p.siteId]
 * @param {Array} p.rows      research rows: { keyword, volume|search_volume, kd|keyword_difficulty, intent }
 * @param {string} p.source   'se_ranking' | 'rankmath' | 'backlog' | 'manual' | 'agent'
 * @returns {Promise<{written:number, skipped:number, source:string}>} never throws for a bad row
 */
export async function recordResearch({ pool, tenantId, siteId = null, rows = [], source = 'agent' }) {
  assertTenant(tenantId);
  let written = 0;
  let skipped = 0;

  for (const row of rows || []) {
    const keyword = String(row?.keyword ?? '').trim();
    // A blank keyword is not a candidate, and it would collide with every other
    // blank on the unique index.
    if (!keyword || keyword.length > 300) { skipped += 1; continue; }

    const volume = Number.isFinite(Number(row.volume ?? row.search_volume)) ? Math.round(Number(row.volume ?? row.search_volume)) : null;
    const kdRaw = Number(row.kd ?? row.keyword_difficulty);
    const kd = Number.isFinite(kdRaw) ? Math.round(kdRaw * 100) / 100 : null;
    const intent = row.intent ? String(row.intent).slice(0, 40) : null;

    try {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('kw', sql.NVarChar(300), keyword)
        .input('vol', sql.Int, volume)
        .input('kd', sql.Decimal(6, 2), kd)
        .input('intent', sql.NVarChar(40), intent)
        .input('source', sql.NVarChar(60), String(source).slice(0, 60))
        .query(`
          MERGE arion.content_keyword_candidate AS tgt
          USING (SELECT @tenantId AS tenant_id, @kw AS keyword) AS s
             ON tgt.tenant_id = s.tenant_id AND tgt.keyword = s.keyword
          WHEN MATCHED THEN UPDATE SET
            search_volume      = COALESCE(@vol, tgt.search_volume),
            keyword_difficulty = COALESCE(@kd, tgt.keyword_difficulty),
            intent             = COALESCE(@intent, tgt.intent),
            source             = @source,
            last_researched_at = SYSDATETIMEOFFSET(),
            -- A refresh must never walk a status back to 'candidate'. What has
            -- been written stays written.
            status = CASE WHEN tgt.status IN ('in_progress','published','rejected')
                          THEN tgt.status ELSE 'candidate' END,
            site_id = COALESCE(@siteId, tgt.site_id)
          WHEN NOT MATCHED THEN
            INSERT (tenant_id, site_id, keyword, search_volume, keyword_difficulty,
                    intent, source, status, last_researched_at)
            VALUES (@tenantId, @siteId, @kw, @vol, @kd, @intent, @source, 'candidate', SYSDATETIMEOFFSET());`);
      written += 1;
    } catch (err) {
      // One bad row must not cost the pass. It is counted, not swallowed: the
      // caller reports `skipped` on the run.
      skipped += 1;
      console.warn(`[keywordCandidates] ${keyword}: ${err.message}`);
    }
  }
  return { written, skipped, source };
}

/**
 * Mark the keywords this run is writing about.
 *
 * Scoped to rows that are NOT already published, so re-running a cycle cannot
 * un-publish anything.
 */
export async function markInProgress({ pool, tenantId, keywords = [] }) {
  assertTenant(tenantId);
  let moved = 0;
  for (const kw of keywords) {
    const keyword = String(kw ?? '').trim();
    if (!keyword) continue;
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('kw', sql.NVarChar(300), keyword)
      .query(`
        UPDATE arion.content_keyword_candidate
           SET status = 'in_progress'
         WHERE tenant_id = @tenantId AND keyword = @kw AND status IN ('candidate','backlog');
        SELECT @@ROWCOUNT AS affected;`);
    moved += Number(r.recordset[0].affected || 0);
  }
  return { moved };
}

/**
 * Mark a keyword published, and point it at the unit that published it.
 *
 * Called from the publish path, not the draft path: a draft nobody approved has
 * not covered its keyword, and marking it published would hide the topic from
 * every future cycle for nothing.
 */
export async function markPublished({ pool, tenantId, keyword, outputId = null }) {
  assertTenant(tenantId);
  const kw = String(keyword ?? '').trim();
  if (!kw) return { moved: 0 };
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('kw', sql.NVarChar(300), kw)
    .input('outputId', sql.UniqueIdentifier, outputId)
    .query(`
      UPDATE arion.content_keyword_candidate
         SET status = 'published', published_output_id = COALESCE(@outputId, published_output_id)
       WHERE tenant_id = @tenantId AND keyword = @kw;
      SELECT @@ROWCOUNT AS affected;`);
  return { moved: Number(r.recordset[0].affected || 0) };
}

/**
 * The backlog the F1 / F6 fallback reads.
 *
 * Ordered easiest-first (lowest difficulty, then highest volume), because the
 * fallback runs on a week when the research tool is DOWN — that is the week to
 * pick the safest topic, not the most ambitious one.
 */
export async function loadBacklog(pool, tenantId, { limit = 20, maxKd = null } = {}) {
  assertTenant(tenantId);
  const req = pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit);
  if (maxKd != null) req.input('maxKd', sql.Decimal(6, 2), maxKd);
  const r = await req.query(`
    SELECT TOP (@limit) keyword, search_volume, keyword_difficulty, intent, source,
           status, last_researched_at
      FROM arion.content_keyword_candidate
     WHERE tenant_id = @tenantId
       AND status IN ('candidate','backlog')
       ${maxKd != null ? 'AND (keyword_difficulty IS NULL OR keyword_difficulty <= @maxKd)' : ''}
     ORDER BY CASE WHEN keyword_difficulty IS NULL THEN 1 ELSE 0 END,
              keyword_difficulty ASC,
              COALESCE(search_volume, 0) DESC`);
  return r.recordset;
}

/** Research older than this is stale and worth re-pulling (edge case E4). */
export async function staleKeywords(pool, tenantId, { olderThanDays = 90, limit = 50 } = {}) {
  assertTenant(tenantId);
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('days', sql.Int, olderThanDays)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) keyword, last_researched_at
        FROM arion.content_keyword_candidate
       WHERE tenant_id = @tenantId
         AND status IN ('candidate','backlog')
         AND (last_researched_at IS NULL
              OR last_researched_at < DATEADD(DAY, -@days, SYSDATETIMEOFFSET()))
       ORDER BY CASE WHEN last_researched_at IS NULL THEN 0 ELSE 1 END, last_researched_at ASC`);
  return r.recordset;
}

export default {
  CANDIDATE_STATUS, recordResearch, markInProgress, markPublished,
  loadBacklog, staleKeywords,
};
