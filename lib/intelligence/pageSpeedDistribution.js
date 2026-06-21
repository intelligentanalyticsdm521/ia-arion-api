// lib/intelligence/pageSpeedDistribution.js — Page Speed Distribution.
//
// REPORT 6 of 6 (single-source: PageSpeed Insights snapshots).
//
// Reads the arion.site_pagespeed_snapshot history and produces a Core Web
// Vitals distribution across the snapshots taken for this site. Tells the
// user what % of crawled URLs (or domain runs) sit in the FAST / AVERAGE
// / SLOW buckets for LCP, INP/FID, and CLS — Google's three CWV signals.
//
// Single-source compliance (locked 2026-06-21): reads ONLY arion.site_-
// pagespeed_snapshot, which is populated by lib/pagespeed.js. No GSC,
// SE Ranking, plugin blend.
//
// Data flow:
//   - ctx.pageSpeedSnapshots: array of snapshot rows passed by the route
//     layer (the layer queries arion.site_pagespeed_snapshot). Each row
//     carries lcp_ms, inp_ms, cls_score, fcp_ms, tbt_ms across run_date
//     and strategy (mobile/desktop).
//
// Falls back to insufficient_data when fewer than 3 snapshots exist.

import { fmtNum, insufficient, result } from './utils.js';

export const REPORT_KEY = 'pagespeed_distribution';

// Google CWV thresholds (https://web.dev/articles/vitals):
const CWV = {
  lcp: { good: 2500, poor: 4000 },        // ms
  inp: { good: 200, poor: 500 },          // ms (FID was 100/300 — INP replaces it)
  cls: { good: 0.1, poor: 0.25 },         // unitless
};

function bucket(value, thresholds) {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value <= thresholds.good) return 'fast';
  if (value <= thresholds.poor) return 'average';
  return 'slow';
}

function distribute(snapshots, fieldName, thresholds) {
  const buckets = { fast: 0, average: 0, slow: 0, unknown: 0 };
  for (const s of snapshots) {
    const v = Number(s?.[fieldName]);
    const b = bucket(v, thresholds);
    buckets[b]++;
  }
  const total = snapshots.length || 1;
  return {
    fast_pct: Math.round((buckets.fast / total) * 100),
    average_pct: Math.round((buckets.average / total) * 100),
    slow_pct: Math.round((buckets.slow / total) * 100),
    unknown_pct: Math.round((buckets.unknown / total) * 100),
    fast: buckets.fast,
    average: buckets.average,
    slow: buckets.slow,
    unknown: buckets.unknown,
  };
}

function avg(snapshots, fieldName) {
  const vals = snapshots.map((s) => Number(s?.[fieldName])).filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export async function calculatePageSpeedDistribution(ctx) {
  const snapshots = Array.isArray(ctx?.pageSpeedSnapshots) ? ctx.pageSpeedSnapshots : [];

  if (snapshots.length === 0) {
    return insufficient(
      REPORT_KEY,
      'No PageSpeed runs yet',
      'Trigger a PageSpeed run from Performance or wait for the nightly snapshot job.',
      ['arion.site_pagespeed_snapshot has no rows for this site yet. The hosting/PageSpeed page can trigger a fresh run on demand.'],
    );
  }

  if (snapshots.length < 3) {
    return insufficient(
      REPORT_KEY,
      `${snapshots.length}/3 snapshots needed`,
      'Run more PageSpeed checks to build a distribution. Mobile + desktop on 2-3 different days gives a reliable baseline.',
      [`${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} available. Distribution analysis needs 3+ runs to surface meaningful variance.`],
    );
  }

  // Bucket distributions per CWV.
  const lcpDist = distribute(snapshots, 'lcp_ms', CWV.lcp);
  const inpDist = distribute(snapshots, 'inp_ms', CWV.inp);
  const clsDist = distribute(snapshots, 'cls_score', CWV.cls);

  // Avg metrics for headline.
  const avgLcp = avg(snapshots, 'lcp_ms');
  const avgInp = avg(snapshots, 'inp_ms');
  const avgCls = avg(snapshots, 'cls_score');

  // Avg performance score directly from Lighthouse — when available.
  const perfScores = snapshots.map((s) => Number(s?.performance_score)).filter((v) => Number.isFinite(v));
  const avgPerf = perfScores.length > 0
    ? perfScores.reduce((s, v) => s + v, 0) / perfScores.length
    : null;

  // Core score: weighted average of % of runs in FAST bucket across the 3 CWVs.
  // Each CWV equally weighted 1/3. Result is 0-100.
  const fastWeight = (lcpDist.fast_pct + inpDist.fast_pct + clsDist.fast_pct) / 3;
  // Blend with Lighthouse perf score when available (40% Lighthouse, 60% CWV dist).
  const score = avgPerf != null
    ? Math.round(avgPerf * 0.4 + fastWeight * 0.6)
    : Math.round(fastWeight);

  const observations = [];
  observations.push(`Distribution across ${fmtNum(snapshots.length)} PageSpeed runs (mobile + desktop, recent history):`);
  observations.push(`LCP — ${lcpDist.fast_pct}% fast (≤2.5s) · ${lcpDist.average_pct}% needs improvement · ${lcpDist.slow_pct}% poor (>4s). Avg: ${avgLcp != null ? `${(avgLcp / 1000).toFixed(2)}s` : 'unavailable'}.`);
  observations.push(`INP — ${inpDist.fast_pct}% fast (≤200ms) · ${inpDist.average_pct}% needs improvement · ${inpDist.slow_pct}% poor (>500ms). Avg: ${avgInp != null ? `${Math.round(avgInp)}ms` : 'unavailable'}.`);
  observations.push(`CLS — ${clsDist.fast_pct}% fast (≤0.1) · ${clsDist.average_pct}% needs improvement · ${clsDist.slow_pct}% poor (>0.25). Avg: ${avgCls != null ? avgCls.toFixed(3) : 'unavailable'}.`);
  if (avgPerf != null) {
    observations.push(`Avg Lighthouse performance score: ${Math.round(avgPerf)}/100 across runs. Google\'s page-experience signal is binary at the page level — all 3 CWVs must hit "fast" for a positive rank-boost.`);
  }

  const actions = [];
  if (lcpDist.slow_pct > 25) {
    actions.push(`LCP poor on ${lcpDist.slow_pct}% of runs. Top causes: large hero images without preload, render-blocking CSS, slow TTFB. Run the LiteSpeed defaults sweep first.`);
  }
  if (inpDist.slow_pct > 25) {
    actions.push(`INP poor on ${inpDist.slow_pct}% of runs. Defer non-critical JS, audit 3rd-party tag manager scripts.`);
  }
  if (clsDist.slow_pct > 15) {
    actions.push(`CLS poor on ${clsDist.slow_pct}% of runs. Add explicit width/height to images + reserve space for embedded widgets (ads, social embeds).`);
  }
  if (lcpDist.fast_pct >= 75 && inpDist.fast_pct >= 75 && clsDist.fast_pct >= 75) {
    actions.push('All 3 CWVs are passing on 75%+ of runs — site is in the rank-eligible band. Maintain current performance posture; monitor for regressions on each deploy.');
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'lcp_fast_pct', value: lcpDist.fast_pct, weight: 0.3, note: '% of runs with LCP ≤2.5s' },
      { key: 'inp_fast_pct', value: inpDist.fast_pct, weight: 0.3, note: '% of runs with INP ≤200ms' },
      { key: 'cls_fast_pct', value: clsDist.fast_pct, weight: 0.4, note: '% of runs with CLS ≤0.1' },
    ],
    avgPerf != null
      ? `Perf ${Math.round(avgPerf)}/100 · ${Math.round(fastWeight)}% of CWVs fast`
      : `${Math.round(fastWeight)}% of CWVs fast across ${snapshots.length} runs`,
    observations,
    actions,
  );
}
