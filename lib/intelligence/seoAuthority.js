// lib/intelligence/seoAuthority.js — SEO Authority Position calculator.
//
// REPORT 1 of 6 (single-source: SE Ranking only).
//
// Models the site's SEO authority position against the competitor pool the
// SE Ranking project is tracking. Composite of:
//   - SE Ranking visibility score (own site)
//   - Avg visibility across the project's competitor list
//   - Backlink stats (referring domains + dofollow count)
//
// Higher is better. Score = clamp(50 + ((own_vis - comp_avg) * 2) + bl_boost).
//
// Single-source compliance (locked 2026-06-21): reads ONLY SE Ranking.
// Acquisition Efficiency (which previously needed SPARK formToContactRate)
// has been folded out of ARION's report set — visit→form analytics belong
// in SPARK; cross-product funnel is ARGUS Cross-Channel territory.
//
// Falls back to insufficient_data when the SE Ranking project hasn't been
// provisioned yet (Lite tenants without SEO add-on) or when no competitors
// have been registered.

import { fmtNum, insufficient, result } from './utils.js';
import { getSiteOverview, getProjectCompetitors, getBacklinkStats, getProjectKeywords } from '../seranking.js';

export const REPORT_KEY = 'seo_authority';

export async function calculateSeoAuthority(ctx) {
  const { seRankingProjectId, tenantId } = ctx;

  if (!seRankingProjectId) {
    return insufficient(
      REPORT_KEY,
      'SE Ranking not connected',
      'Add the IA SEO package to provision an SE Ranking project — required for authority scoring.',
      ['The SEO Authority Position report compares your visibility against tracked competitors. Both require an SE Ranking project.'],
    );
  }

  // Fetch in parallel; each call is independently cache-able at the seranking lib layer.
  //
  // 2026-06-22 — `total_keywords` is NOT returned by SE Ranking's
  // `GET /sites/{projectId}` payload. The authoritative keyword count
  // lives on `GET /sites/{projectId}/keywords` (the keyword array). The
  // old code read `overview.total_keywords`, coerced `undefined → 0`, and
  // short-circuited every Authority-tier tenant with "no tracked keywords"
  // even when 98 keywords were actually tracked. Pull the count from the
  // keyword endpoint and only bail out when THAT returns empty.
  // 2026-06-22 — Sentinel-based failure detection. The seranking lib
  // swallows HTTP errors and returns null / []. Without separating
  // "API call failed" from "API returned 0 rows", an upstream 400 on
  // /sites/{id} produced ownVisibility=0 → score = 50 + 0 + 0 = 50,
  // implying a real "parity" reading when in fact we had no data.
  const FAIL = Symbol('fail');
  const [overview, competitors, backlinkStats, keywords] = await Promise.all([
    getSiteOverview(seRankingProjectId, tenantId).catch(() => FAIL),
    getProjectCompetitors(seRankingProjectId, tenantId).catch(() => FAIL),
    getBacklinkStats(seRankingProjectId, tenantId).catch(() => FAIL),
    getProjectKeywords(seRankingProjectId, tenantId).catch(() => FAIL),
  ]);

  // Hard-fail when the primary signal source errored.
  if (overview === FAIL || keywords === FAIL) {
    return insufficient(
      REPORT_KEY,
      'SE Ranking API unavailable',
      'SE Ranking returned an error for site overview or keywords — retrying on the next refresh cycle.',
      ['Upstream SE Ranking call failed. Cached intelligence will refresh on the next 12-hour cycle or manual recalculate.'],
    );
  }

  // Treat secondary-source failures as "no data" for those slots without
  // killing the whole report. Backlinks + competitors are enrichments.
  const safeCompetitors = competitors === FAIL ? [] : competitors;
  const safeBacklinkStats = backlinkStats === FAIL ? null : backlinkStats;

  const ownVisibility = Number(overview?.visibility ?? overview?.visibility_score ?? 0);
  const trackedKeywords = Array.isArray(keywords) ? keywords.length : 0;

  if (trackedKeywords === 0) {
    return insufficient(
      REPORT_KEY,
      'No tracked keywords',
      'Add tracked keywords to the SE Ranking project to begin authority scoring.',
      [`The project is registered but has 0 tracked keywords — visibility can't be measured without ranking targets.`],
    );
  }

  // Average competitor visibility (when SE Ranking returns it on the competitor list).
  const competitorVisibilities = Array.isArray(safeCompetitors)
    ? safeCompetitors.map((c) => Number(c?.visibility ?? c?.visibility_score ?? 0)).filter((v) => Number.isFinite(v) && v > 0)
    : [];
  const competitorAvg = competitorVisibilities.length > 0
    ? competitorVisibilities.reduce((s, n) => s + n, 0) / competitorVisibilities.length
    : null;

  const referringDomains = Number(safeBacklinkStats?.referring_domains ?? safeBacklinkStats?.refdomains ?? 0);
  const dofollowBacklinks = Number(safeBacklinkStats?.dofollow ?? safeBacklinkStats?.backlinks_dofollow ?? 0);
  // Backlink boost: 0-15 points based on referring domain count (50 RDs → full boost).
  const blBoost = Math.min(referringDomains / 50, 1) * 15;

  // Score base: 50 (parity). Each visibility point of lead = +2; each point behind = -2.
  // If no competitors, neutral base + backlink boost only.
  const visGap = competitorAvg != null ? ownVisibility - competitorAvg : 0;
  const score = Math.round(50 + (visGap * 2) + blBoost);

  const observations = [];
  observations.push(`Own visibility: ${ownVisibility.toFixed(1)}% across ${trackedKeywords} tracked keywords.`);
  if (competitorAvg != null) {
    observations.push(`Competitor average: ${competitorAvg.toFixed(1)}% (${competitorVisibilities.length} competitors). You are ${visGap >= 0 ? 'ahead' : 'behind'} by ${Math.abs(visGap).toFixed(1)} points.`);
  } else {
    observations.push('No competitors tracked yet — head-to-head visibility comparison is unavailable.');
  }
  observations.push(`Backlink profile: ${fmtNum(referringDomains)} referring domains, ${fmtNum(dofollowBacklinks)} dofollow links.`);

  const actions = [];
  if (visGap < -5) {
    actions.push('Visibility gap of 5+ points is sustained ground loss. Run keyword gap analysis vs the top-3 competitors and prioritize the queries where they outrank you 1-10.');
  }
  if (referringDomains < 20) {
    actions.push('Referring domain count is low. Pursue 2-3 high-quality backlinks per month from industry directories, partner sites, and earned mentions.');
  }
  if (competitorVisibilities.length === 0) {
    actions.push('Add 3-5 known competitors to the SE Ranking project so head-to-head visibility can be tracked.');
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'own_visibility', value: Number(ownVisibility.toFixed(1)), weight: 0.5, note: 'SE Ranking visibility %' },
      { key: 'competitor_avg', value: competitorAvg != null ? Number(competitorAvg.toFixed(1)) : null, weight: 0.3, note: `${competitorVisibilities.length} competitors` },
      { key: 'referring_domains', value: referringDomains, weight: 0.2, note: 'unique referring domains' },
    ],
    competitorAvg != null
      ? `${visGap >= 0 ? '+' : ''}${visGap.toFixed(1)} points vs ${competitorVisibilities.length} competitors · ${ownVisibility.toFixed(1)}% visibility`
      : `${ownVisibility.toFixed(1)}% visibility · no competitors tracked`,
    observations,
    actions,
    competitorVisibilities.length > 0 ? 'ok' : 'partial',
    competitorVisibilities.length === 0 ? 'Add competitors for head-to-head scoring.' : undefined,
  );
}
