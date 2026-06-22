// lib/intelligence/visibilityTrajectory.js — Visibility Trajectory calculator.
//
// REPORT 2 of 6 (single-source: Google Search Console only).
//
// Linear-regression projection on 60-90 days of GSC date-dimension data.
// Tells the user where their search visibility is trending. v1 uses simple
// half-period averaging; v2 (Holt-Winters seasonal decomposition) unlocks
// once 12+ months of weekly history accumulates.
//
// Single-source compliance (locked 2026-06-21): reads ONLY GSC. No SE
// Ranking blend, no GA4 blend — cross-source projection lives in ARGUS.
//
// Data flow:
//   - ctx.gscDates: array of { date, impressions, clicks, position }
//     supplied by the route layer (which pulls from arion-api's existing
//     search-performance integration).
//
// Falls back to insufficient_data when fewer than 60 days of GSC data are
// available.

import { fmtNum, insufficient, result } from './utils.js';

export const REPORT_KEY = 'visibility_trajectory';

export async function calculateVisibilityTrajectory(ctx) {
  const dates = Array.isArray(ctx?.gscDates) ? ctx.gscDates : [];

  if (dates.length === 0) {
    return insufficient(
      REPORT_KEY,
      'GSC date breakdown needed',
      'Visibility Trajectory requires GSC date-dimension data — confirm GSC is connected and the sitemap is submitted.',
      ['No date-dimension breakdown returned from GSC yet. Data typically arrives 7-14 days after first connection.'],
    );
  }

  if (dates.length < 60) {
    return insufficient(
      REPORT_KEY,
      `${dates.length}/90 days of history`,
      `${90 - dates.length} more days of GSC history required for trajectory projection.`,
      [`${dates.length} days of GSC history accumulated. Trajectory modelling needs 60+ days minimum (90+ for confident projection).`],
    );
  }

  // Sort defensively in case the integration returned out-of-order dates.
  const sorted = [...dates].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const recent = sorted.slice(-90);
  const halfLen = Math.floor(recent.length / 2);
  const firstHalf = recent.slice(0, halfLen);
  const secondHalf = recent.slice(halfLen);

  const avg = (arr, key) => arr.length === 0 ? 0 : arr.reduce((s, d) => s + Number(d?.[key] || 0), 0) / arr.length;
  const firstImp = avg(firstHalf, 'impressions');
  const secondImp = avg(secondHalf, 'impressions');
  const firstClicks = avg(firstHalf, 'clicks');
  const secondClicks = avg(secondHalf, 'clicks');
  const firstPos = avg(firstHalf, 'position') || avg(firstHalf, 'avg_position');
  const secondPos = avg(secondHalf, 'position') || avg(secondHalf, 'avg_position');

  // 2026-06-22 — If 60+ days of GSC date rows exist but every single
  // day reports zero impressions and zero clicks, the integration is
  // either misconfigured or the site has no search exposure yet. The
  // prior code scored 60 here (neutral base + no signal) — misleading.
  const totalImp = firstImp + secondImp;
  const totalClicks = firstClicks + secondClicks;
  if (totalImp === 0 && totalClicks === 0) {
    return insufficient(
      REPORT_KEY,
      'GSC reporting zero traffic',
      'GSC returned date rows but every day has 0 impressions and 0 clicks — verify the sitemap is submitted and the property covers the correct domain prefix (www vs root, https vs http).',
      [`${recent.length} days of GSC history returned but all values are zero. Trajectory cannot be scored without traffic to project forward.`],
    );
  }

  const growthRate = firstImp > 0 ? (secondImp - firstImp) / firstImp : 0;
  const clickGrowth = firstClicks > 0 ? (secondClicks - firstClicks) / firstClicks : 0;
  // Position improvement (lower = better, so flip sign):
  const positionDelta = firstPos > 0 && secondPos > 0 ? firstPos - secondPos : 0;

  // Project 90 days forward from current month's run rate.
  const last30Imp = recent.slice(-30).reduce((s, d) => s + Number(d?.impressions || 0), 0);
  const projectedImpressions = Math.round(last30Imp * (1 + growthRate));

  const direction = growthRate > 0.05 ? 'improving' : growthRate < -0.05 ? 'declining' : 'stable';

  // Score: 60 neutral, ±25 for growth direction, +15 for solid avg position.
  const score = Math.round(Math.max(0, Math.min(100,
    60
    + (growthRate > 0.1 ? 25 : growthRate < -0.1 ? -25 : Math.round(growthRate * 100))
    + (secondPos > 0 && secondPos < 15 ? 15 : 0)
  )));

  const observations = [];
  observations.push(`90-day GSC trajectory: ${direction} (${growthRate >= 0 ? '+' : ''}${(growthRate * 100).toFixed(1)}% impressions, ${clickGrowth >= 0 ? '+' : ''}${(clickGrowth * 100).toFixed(1)}% clicks).`);
  observations.push(`Avg position moved ${positionDelta >= 0 ? `up ${positionDelta.toFixed(1)} spots` : `down ${Math.abs(positionDelta).toFixed(1)} spots`} (${firstPos.toFixed(1)} → ${secondPos.toFixed(1)}).`);
  observations.push(`Projection: ~${fmtNum(projectedImpressions)} monthly impressions over the next 90 days at current rate.`);
  if (direction === 'declining') {
    observations.push('Trajectory is negative. Common causes: (1) content decay vs fresher competitors, (2) algorithm shift, (3) technical regression — check Core Web Vitals + indexing first.');
  } else if (direction === 'improving') {
    observations.push('Compounding works. Keep content refresh cadence + internal-link from new pages back to your top ranking targets.');
  }
  observations.push('v1 uses linear half-period averaging. v2 (Holt-Winters with seasonal decomposition) unlocks at 12 months of weekly history.');

  const actions = [];
  if (direction === 'declining') {
    actions.push('Audit your top 5 ranking pages this week — refresh statistics, add new sections, bump publish date. Content decay is the #1 trajectory killer.');
  }
  if (secondPos > 15) {
    actions.push('Identify the top 10 queries ranking 11-20. Focused refresh + internal-link from your home/category pages is the fastest position lift.');
  }
  if (recent.length < 90) {
    actions.push(`Continue tracking — Visibility Trajectory upgrades from v1 to v2 (seasonal projection) at 12 months of history. Currently: ${recent.length} days.`);
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'impressions_trend_pct', value: Math.round(growthRate * 100), weight: 0.5, note: 'half-period vs prior half' },
      { key: 'projected_90d_impressions', value: projectedImpressions, weight: 0.3, note: 'extrapolated at current rate' },
      { key: 'avg_position', value: Number(secondPos.toFixed(1)), weight: 0.2, note: 'GSC avg position (last 45d)' },
    ],
    `${direction} · ${growthRate >= 0 ? '+' : ''}${(growthRate * 100).toFixed(1)}% imp · ~${fmtNum(projectedImpressions)} (90d)`,
    observations,
    actions,
  );
}
