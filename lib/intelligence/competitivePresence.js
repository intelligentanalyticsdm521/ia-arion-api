// lib/intelligence/competitivePresence.js — Competitive Presence Gap calculator.
//
// REPORT 3 of 6 (single-source: SE Ranking only).
//
// Measures % of tracked target keywords where a competitor outranks the
// client. Quantifies the size of the head-to-head ranking deficit you're
// carrying against the competitor set SE Ranking is watching.
//
// Single-source compliance (locked 2026-06-21): reads ONLY SE Ranking.
// gscQueries used to be passed for a cross-source cross-check; per the
// refactor each ARION report is confined to one data source. Cross-source
// comparisons live in ARGUS.
//
// Data flow:
//   - SE Ranking project keywords (the tracked-target universe)
//   - SE Ranking keyword positions (own + competitor ranks per query)
//
// Score inverts the gap rate: 0 gaps = 100; 50% gaps = 0.
//
// Falls back gracefully when SE Ranking isn't connected or no keywords
// are tracked yet.

import { insufficient, result } from './utils.js';
import { getProjectKeywords, getKeywordPositions } from '../seranking.js';

export const REPORT_KEY = 'competitive_presence';

export async function calculateCompetitivePresence(ctx) {
  const { seRankingProjectId, tenantId } = ctx;

  if (!seRankingProjectId) {
    return insufficient(
      REPORT_KEY,
      'SE Ranking not connected',
      'Connect SE Ranking to enable competitor keyword gap analysis.',
      ['Content Gap Index reads tracked keyword rankings + competitor positions from SE Ranking.'],
    );
  }

  // 2026-06-22 — Track API success separately from empty arrays. The
  // seranking lib swallows HTTP 4xx/5xx and returns []. Without this
  // distinction, an upstream 400 on /sites/{id}/positions used to flow
  // through to gapCount=0 → gapRate=0 → score=100, masquerading as a
  // perfect competitive posture. Use a sentinel object so we can tell
  // "API said 0 rows" (legit empty) from "API errored" (no_data).
  const FAIL = Symbol('fail');
  const [trackedKws, positions] = await Promise.all([
    getProjectKeywords(seRankingProjectId, tenantId).catch(() => FAIL),
    getKeywordPositions(seRankingProjectId, tenantId).catch(() => FAIL),
  ]);

  if (trackedKws === FAIL || positions === FAIL) {
    return insufficient(
      REPORT_KEY,
      'SE Ranking API unavailable',
      'SE Ranking returned an error for project keywords or positions — retrying on the next refresh cycle.',
      ['Upstream SE Ranking call failed. Cached intelligence will refresh on the next 12-hour cycle or manual recalculate.'],
    );
  }

  const totalTracked = Array.isArray(trackedKws) ? trackedKws.length : 0;
  if (totalTracked === 0) {
    return insufficient(
      REPORT_KEY,
      'No tracked keywords',
      'Track keywords in SE Ranking to compute gap index.',
      ['Add keyword targets in SE Ranking — Content Gap measures opportunities relative to the tracked universe.'],
    );
  }

  // 2026-06-22 — If we have tracked keywords but zero position rows, the
  // positions endpoint hasn't populated yet (audit-style "scan not yet
  // run") — DO NOT score 100. Bail to no_data so the UI shows pending
  // rather than implying a perfect competitive standing.
  const positionRows = Array.isArray(positions) ? positions : [];
  if (positionRows.length === 0) {
    return insufficient(
      REPORT_KEY,
      'No position data yet',
      'SE Ranking hasn\'t reported ranking positions for the tracked keywords yet — first scan typically completes within 24 hours of project setup.',
      [`Tracked ${totalTracked} keyword${totalTracked === 1 ? '' : 's'} but 0 position rows returned. Gap analysis needs at least one ranking row to compute.`],
    );
  }

  // Index positions by keyword_id. SE Ranking returns multiple rows
  // per keyword (one per search engine). Take the best (lowest) position
  // across engines for the gap computation.
  const ownPositionByKwId = new Map();
  const competitorTopPositionByKwId = new Map();
  let competitorRowCount = 0;
  for (const row of positionRows) {
    const kwId = row?.keyword_id;
    if (kwId == null) continue;
    const ownPos = Number(row?.position ?? row?.own_position ?? 0);
    if (ownPos > 0 && (!ownPositionByKwId.has(kwId) || ownPositionByKwId.get(kwId) > ownPos)) {
      ownPositionByKwId.set(kwId, ownPos);
    }
    const compPositions = Array.isArray(row?.competitors)
      ? row.competitors.map((c) => Number(c?.position || 0)).filter((p) => p > 0)
      : [];
    if (compPositions.length > 0) competitorRowCount++;
    const compBest = compPositions.length > 0 ? Math.min(...compPositions) : null;
    if (compBest != null && (!competitorTopPositionByKwId.has(kwId) || competitorTopPositionByKwId.get(kwId) > compBest)) {
      competitorTopPositionByKwId.set(kwId, compBest);
    }
  }

  // 2026-06-22 — If position rows exist but NONE carry competitor data,
  // we literally cannot measure competitive presence. The prior code
  // would silently score 100 here (0 gaps, 0 competitor wins → gapRate=0
  // → score=100). Bail to no_data so the UI shows the real state.
  if (competitorTopPositionByKwId.size === 0) {
    return insufficient(
      REPORT_KEY,
      'No competitor ranking data',
      'SE Ranking is tracking your keywords but has not surfaced competitor positions for any of them — add competitors to the SE Ranking project or wait for the next scan.',
      [`${positionRows.length} position row${positionRows.length === 1 ? '' : 's'} returned but ${competitorRowCount} carried competitor positions. Gap analysis needs at least one competitor ranking to compare against.`],
    );
  }

  // Count gaps: competitor in top-10 AND own position > 100 (or missing entirely).
  let gapCount = 0;
  let competitorWinCount = 0;  // competitor top-10 + own present but worse
  let ownTop10 = 0;
  for (const kw of trackedKws) {
    const kwId = kw?.keyword_id ?? kw?.id;
    if (kwId == null) continue;
    const own = ownPositionByKwId.get(kwId) || 0;
    const compBest = competitorTopPositionByKwId.get(kwId) || 0;
    if (own > 0 && own <= 10) ownTop10++;
    if (compBest > 0 && compBest <= 10) {
      if (own === 0 || own > 100) gapCount++;
      else if (own > 10) competitorWinCount++;
    }
  }

  // Gap rate: % of tracked queries where competitor wins and we're absent.
  const gapRate = totalTracked > 0 ? gapCount / totalTracked : 0;
  // Score: invert gap rate. 0 gaps = 100, 50% gaps = 0.
  const score = Math.round(Math.max(0, 100 - (gapRate * 200)));

  const observations = [];
  observations.push(`Tracked keyword universe: ${totalTracked}. Own top-10: ${ownTop10}. Competitor top-10 where you're missing: ${gapCount}.`);
  observations.push(`Gap rate: ${(gapRate * 100).toFixed(1)}% — every 1% of gaps is a page you could publish to compete for traffic.`);
  if (competitorWinCount > 0) {
    observations.push(`Additionally, ${competitorWinCount} queries where you rank 11-100 while competitors hold top-10 — these are refresh-cheaper than net-new content.`);
  }

  const actions = [];
  if (gapCount >= 5) {
    actions.push(`Audit the ${Math.min(gapCount, 10)} highest-volume gaps. For each, draft a 600-800 word page targeting the query — competitors are ranking, so demand exists.`);
  }
  if (competitorWinCount >= 10) {
    actions.push(`${competitorWinCount} queries where competitors rank top-10 but you're ranking 11-100. Refresh + internal-link the relevant pages first — these are cheaper wins than net-new content.`);
  }
  if (gapCount === 0 && competitorWinCount === 0) {
    actions.push('No identifiable gaps — expand the tracked keyword list to surface new opportunities or add 1-2 more competitors to enrich comparison data.');
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'tracked_keywords', value: totalTracked, weight: 0.3, note: 'SE Ranking project keywords' },
      { key: 'gap_count', value: gapCount, weight: 0.5, note: 'competitor top-10 + own missing' },
      { key: 'own_top10', value: ownTop10, weight: 0.2, note: 'queries you rank top-10' },
    ],
    `${gapCount} gap${gapCount === 1 ? '' : 's'} · ${(gapRate * 100).toFixed(1)}% of tracked universe`,
    observations,
    actions,
  );
}
