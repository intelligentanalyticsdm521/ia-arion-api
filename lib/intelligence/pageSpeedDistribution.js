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
// Falls back to insufficient_data only when zero snapshots exist. With 1
// snapshot we still bail (no distribution from a single point). With 2+
// snapshots we compute the distribution and flag state:'partial' until 3+
// snapshots accumulate — the per-strategy mobile/desktop split already
// yields a useful signal at n=2.

import { fmtNum, insufficient, result, applyAgeMultiplier } from './utils.js';

export const REPORT_KEY = 'pagespeed_distribution';

// F-Onb-D7 — signals this calculator consumes. Keys must match utils.js SIGNAL_REGISTRY.
export const SIGNALS_USED = [
  { key: 'psi.snapshot', tier: 'free', label: 'PageSpeed Insights snapshot' },
  { key: 'psi.cwv.lcp',  tier: 'free', label: 'Core Web Vitals — LCP' },
  { key: 'psi.cwv.cls',  tier: 'free', label: 'Core Web Vitals — CLS' },
  { key: 'psi.cwv.inp',  tier: 'free', label: 'Core Web Vitals — INP' },
];

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

  if (snapshots.length < 2) {
    return insufficient(
      REPORT_KEY,
      `${snapshots.length}/2 snapshots needed`,
      'Run at least one more PageSpeed check to build a distribution. Mobile + desktop on 2-3 different days gives a reliable baseline.',
      [`${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} available. Distribution analysis needs 2+ runs minimum (3+ for confident variance).`],
    );
  }

  // 2026-06-22 — n=2 still computes; just mark partial so the UI can label
  // it as preliminary. The mobile vs desktop split alone is informative.
  const isPartial = snapshots.length < 3;

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
  const rawScore = avgPerf != null
    ? avgPerf * 0.4 + fastWeight * 0.6
    : fastWeight;
  const dampened = applyAgeMultiplier(rawScore, ctx?.siteAgeMultiplier ?? 1.0);
  const score = Math.round(Math.max(0, Math.min(100, dampened)));

  const observations = [];
  if ((ctx?.siteAgeMultiplier ?? 1.0) < 1.0) {
    observations.push(`Site age multiplier: ${ctx.siteAgeMultiplier.toFixed(2)} — score dampened for new site`);
  }
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
      ? `Perf ${Math.round(avgPerf)}/100 · ${Math.round(fastWeight)}% of CWVs fast${isPartial ? ' (preliminary, 2 runs)' : ''}`
      : `${Math.round(fastWeight)}% of CWVs fast across ${snapshots.length} runs${isPartial ? ' (preliminary)' : ''}`,
    observations,
    actions,
    isPartial ? 'partial' : 'ok',
    isPartial ? `Preliminary distribution from ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} — refines once 3+ runs accumulate.` : undefined,
  );
}
