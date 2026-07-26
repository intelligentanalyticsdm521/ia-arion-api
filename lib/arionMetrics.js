// lib/arionMetrics.js — the ARION monthly metric series provider.
//
// ONE endpoint returns 12 months of EVERY ARION data point for a site, so the
// client builds all six Trends dashboards from a single fetch. This is the
// storage foundation the whole Insights model rests on (see
// overnight-report/INSIGHTS_MODEL_SPEC.md): every data point is a monthly time
// series, and sections / dashboards / scores are just roll-ups of these.
//
//   PROD  — read arion.metric_monthly (filled by the monthly snapshot job,
//           a named deploy requirement; not yet built).
//   DEV   — when ARION_DEMO_DATA=true, generate a deterministic 12-month
//           series per metric so the dashboards render and are reviewable.
//
// The metric KEYS here are the contract with the client catalog
// (Portal-mybrand/src/analytics/arionDashboards.ts). Add a metric in both.

import sql from 'mssql';
import { demoDataEnabled, demoShouldServe } from './demoData.js';
import { demoArionDetail } from './arionDetail.js';

// ── Per-industry anchor values. Demo series are built around these so a
//    landscaper, a dentist and a cafe read differently and believably. ──
const INDUSTRY = {
  Landscaping: { volume: 1.0, seasonal: 'summer', rating: 4.3, reviews: 42 },
  'Dental Practice': { volume: 0.8, seasonal: 'flat', rating: 4.6, reviews: 88 },
  Cafe: { volume: 1.2, seasonal: 'flat', rating: 4.2, reviews: 130 },
  default: { volume: 1.0, seasonal: 'flat', rating: 4.3, reviews: 60 },
};

// Deterministic PRNG so a site always renders the same numbers (reproducible
// walkthrough videos).
function rng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

// Seasonal multiplier by month index (0=Jan) for a "summer" business.
function seasonalMul(kind, monthIdx) {
  if (kind !== 'summer') return 1;
  // Landscaping peaks May-Aug, troughs Dec-Feb.
  const curve = [0.55, 0.6, 0.78, 0.95, 1.15, 1.3, 1.3, 1.2, 1.0, 0.82, 0.66, 0.55];
  return curve[monthIdx];
}

/**
 * Build a 12-month series (oldest→newest) around a base value with drift, a
 * seasonal shape, light noise, and an explicit recent move so the reports have
 * something to say. `dir` biases the last 2 months up (+1) or down (-1).
 */
function series(rand, base, { drift = 0.02, seasonal = 'flat', noise = 0.05, dir = 0, integer = false, min = 0 } = {}) {
  const now = new Date();
  const out = [];
  for (let m = 11; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const monthsAgo = m;
    const growth = 1 + drift * (11 - monthsAgo);          // gentle upward trend over the year
    const seas = seasonalMul(seasonal, d.getUTCMonth());
    const n = 1 + (rand() - 0.5) * 2 * noise;
    let recent = 1;
    if (dir !== 0 && monthsAgo <= 1) recent = 1 + dir * (0.12 + rand() * 0.16); // last 2 months moved
    let v = base * growth * seas * n * recent;
    if (v < min) v = min;
    out.push(integer ? Math.round(v) : Number(v.toFixed(4)));
  }
  return out;
}

/**
 * The full ARION metric set as monthly series for one site.
 * Returns { metricKey: number[12] } plus a couple of scalar helpers.
 */
export function demoArionMetrics(site) {
  const ind = INDUSTRY[site.business_type] || INDUSTRY[site.industry] || INDUSTRY.default;
  const R = (salt) => rng(`${site.domain || site.site_id}:${salt}`);
  const vol = ind.volume;
  const M = {};

  // ── SEARCH VISIBILITY ──
  M.gsc_impressions   = series(R('impr'), 3200 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1 });
  M.gsc_clicks        = series(R('clk'), 105 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.gsc_ctr           = M.gsc_impressions.map((im, i) => Number(((M.gsc_clicks[i] / im) * 100).toFixed(2)));
  M.gsc_avg_position  = series(R('pos'), 14, { drift: -0.012, noise: 0.04, dir: 1 }).map((v) => Number(Math.max(1, v).toFixed(1)));
  M.kw_tracked        = series(R('kwt'), 25, { drift: 0.01, noise: 0.01, integer: true });
  M.kw_top3           = series(R('kw3'), 3, { drift: 0.05, noise: 0.15, dir: 1, integer: true });
  M.kw_top10          = series(R('kw10'), 8, { drift: 0.04, noise: 0.1, dir: 1, integer: true });
  M.kw_top30          = series(R('kw30'), 16, { drift: 0.02, noise: 0.06, integer: true });
  M.kw_visibility     = series(R('vis'), 34, { drift: 0.03, noise: 0.05, dir: 1 }).map((v) => Number(v.toFixed(1)));
  M.bing_impressions  = series(R('bimpr'), 420 * vol, { drift: 0.02, seasonal: ind.seasonal, integer: true });
  M.bing_clicks       = series(R('bclk'), 12 * vol, { drift: 0.02, integer: true });
  M.backlinks         = series(R('bl'), 180, { drift: 0.02, noise: 0.03, integer: true });
  M.referring_domains = series(R('rd'), 42, { drift: 0.02, noise: 0.03, integer: true });

  // ── LOCAL PRESENCE ──
  M.gbp_impressions      = series(R('gimpr'), 5200 * vol, { drift: 0.025, seasonal: ind.seasonal, dir: 1, integer: true });
  M.gbp_impr_maps        = M.gbp_impressions.map((v, i) => Math.round(v * (0.5 + R('mapsplit')() * 0.05)));
  M.gbp_impr_search      = M.gbp_impressions.map((v, i) => v - M.gbp_impr_maps[i]);
  M.gbp_calls            = series(R('calls'), 62 * vol, { drift: 0.02, seasonal: ind.seasonal, integer: true });
  M.gbp_directions       = series(R('dir'), 88 * vol, { drift: 0.02, seasonal: ind.seasonal, integer: true });
  M.gbp_website_clicks   = series(R('wclk'), 140 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.gbp_action_rate      = M.gbp_impressions.map((im, i) => Number((((M.gbp_calls[i] + M.gbp_directions[i] + M.gbp_website_clicks[i]) / im) * 100).toFixed(2)));
  M.gbp_rating           = series(R('rate'), ind.rating, { drift: 0.001, noise: 0.01 }).map((v) => Number(Math.min(5, v).toFixed(2)));
  M.gbp_review_count     = series(R('rc'), ind.reviews, { drift: 0.02, noise: 0.01, integer: true });
  M.gbp_review_velocity  = series(R('rv'), ind.reviews * 0.06, { drift: 0.01, noise: 0.2, dir: -1, integer: true });
  M.gbp_response_rate    = series(R('rr'), 68, { drift: 0.02, noise: 0.04, dir: 1 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.gbp_posts            = series(R('posts'), 4, { drift: 0.01, noise: 0.3, dir: -1, integer: true });

  // ── AUDIENCE & CONVERSION ──
  M.ga_sessions          = series(R('sess'), 2100 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.ga_users             = M.ga_sessions.map((v) => Math.round(v * 0.84));
  M.ga_new_users         = M.ga_users.map((v, i) => Math.round(v * (0.6 + R('nu')() * 0.1)));
  M.ga_engagement_rate   = series(R('eng'), 55, { drift: 0.005, noise: 0.03, dir: 1 }).map((v) => Number(Math.min(100, v).toFixed(1)));
  M.ga_bounce_rate       = M.ga_engagement_rate.map((v) => Number((100 - v).toFixed(1)));
  M.ga_avg_duration      = series(R('dur'), 96, { drift: 0.01, noise: 0.06, integer: true });
  M.ga_pages_per_session = series(R('pps'), 2.1, { drift: 0.005, noise: 0.05 }).map((v) => Number(v.toFixed(2)));
  M.ga_mobile_share      = series(R('mob'), 62, { drift: 0.003, noise: 0.02 }).map((v) => Number(v.toFixed(0)));
  M.ga_returning_share   = series(R('ret'), 38, { drift: 0.004, noise: 0.03 }).map((v) => Number(v.toFixed(0)));
  M.ga_conversions       = series(R('conv'), 38 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.form_submissions     = series(R('form'), 26 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.ga_conversion_rate   = M.ga_conversions.map((c, i) => Number(((c / M.ga_sessions[i]) * 100).toFixed(2)));

  // ── CONTENT ──
  M.content_pageviews      = series(R('pv'), 5400 * vol, { drift: 0.03, seasonal: ind.seasonal, dir: 1, integer: true });
  M.content_top_page_share = series(R('tps'), 34, { drift: -0.004, noise: 0.03 }).map((v) => Number(v.toFixed(0)));
  M.content_engaged_pages  = series(R('epg'), 18, { drift: 0.02, noise: 0.05, integer: true });
  M.content_fresh_ratio    = series(R('fresh'), 42, { drift: 0.01, noise: 0.04, dir: -1 }).map((v) => Number(v.toFixed(0)));
  M.content_avg_age_days   = series(R('age'), 210, { drift: 0.01, noise: 0.03, integer: true });
  M.content_avg_words      = series(R('words'), 720, { drift: 0.01, noise: 0.03, integer: true });
  M.content_rankmath_avg   = series(R('rm'), 74, { drift: 0.01, noise: 0.03, dir: 1 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.content_thin_ratio     = series(R('thin'), 22, { drift: -0.01, noise: 0.05, dir: 1 }).map((v) => Number(v.toFixed(0)));
  M.content_gap_count      = series(R('gap'), 14, { drift: -0.01, noise: 0.08, dir: 1, integer: true });

  // ── TECHNICAL & SITE HEALTH ──
  M.psi_mobile_perf     = series(R('pmob'), 58, { drift: 0.015, noise: 0.04, dir: 1 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.psi_desktop_perf    = series(R('pdesk'), 82, { drift: 0.008, noise: 0.02 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.psi_accessibility   = series(R('a11y'), 78, { drift: 0.006, noise: 0.02 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.psi_seo             = series(R('pseo'), 92, { drift: 0.003, noise: 0.01 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.psi_best_practices  = series(R('bp'), 88, { drift: 0.003, noise: 0.02 }).map((v) => Number(Math.min(100, v).toFixed(0)));
  M.lcp_ms              = series(R('lcp'), 3200, { drift: -0.015, noise: 0.05, dir: 1, integer: true });
  M.inp_ms              = series(R('inp'), 220, { drift: -0.01, noise: 0.06, integer: true });
  M.cls                 = series(R('cls'), 0.06, { drift: -0.01, noise: 0.1 }).map((v) => Number(Math.max(0, v).toFixed(3)));
  M.cwv_pass            = M.lcp_ms.map((l, i) => (l <= 2500 && M.cls[i] <= 0.1 && M.inp_ms[i] <= 200) ? 100 : 0);
  M.audit_errors        = series(R('aerr'), 12, { drift: -0.02, noise: 0.08, integer: true, min: 0 });
  M.audit_warnings      = series(R('awarn'), 34, { drift: -0.01, noise: 0.06, integer: true, min: 0 });
  M.security_vulns      = series(R('vuln'), 2, { drift: -0.03, noise: 0.3, integer: true, min: 0 });
  M.security_blocked    = series(R('block'), 420, { drift: 0.02, noise: 0.2, integer: true });
  M.ssl_valid           = new Array(12).fill(100);
  M.broken_links        = series(R('brk'), 6, { drift: -0.02, noise: 0.15, integer: true, min: 0 });
  M.redirects           = series(R('redir'), 18, { drift: -0.005, noise: 0.05, integer: true, min: 0 });
  M.indexable_pages     = series(R('idx'), 42, { drift: 0.01, noise: 0.02, integer: true });

  return M;
}

/**
 * Entry point. Returns { source: 'demo'|'prod', months: [...12 'YYYY-MM'],
 * metrics: { key: number[12] } } or null when neither demo nor prod data exists.
 */
export async function getArionMetrics(pool, site, months = 12) {
  const monthLabels = [];
  const now = new Date();
  for (let m = months - 1; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    monthLabels.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  if (demoDataEnabled() && demoShouldServe(site)) {
    return { source: 'demo', months: monthLabels, metrics: demoArionMetrics(site), detail: demoArionDetail(site) };
  }

  // PROD path — read arion.metric_monthly (backfilled 2026-07-25 for all four
  // sites; kept current by the arion-func insightsMonthlySnapshot timer).
  try {
    // Overall series only — dimension rows are the detail layer below.
    const r = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('n', sql.Int, months)
      .query(`SELECT metric_key, period_month, value
              FROM arion.metric_monthly
              WHERE site_id = @siteId AND dimension IS NULL
                AND period_month >= DATEADD(month, -@n, DATEFROMPARTS(YEAR(GETUTCDATE()), MONTH(GETUTCDATE()), 1))
              ORDER BY period_month`);
    if (!r.recordset.length) return { source: 'prod', months: monthLabels, metrics: {} };
    const metrics = {};
    const idxOf = new Map(monthLabels.map((l, i) => [l, i]));
    for (const row of r.recordset) {
      const label = row.period_month.toISOString().slice(0, 7);
      const i = idxOf.get(label);
      if (i == null) continue;
      if (!metrics[row.metric_key]) metrics[row.metric_key] = new Array(months).fill(null);
      metrics[row.metric_key][i] = Number(row.value);
    }

    // ── Running-month + unmeasured guards (Briarwood autopsy, 2026-07-25) ──
    // 1. SUM metrics: the current calendar month is a RUNNING month — scoring
    //    a half month as complete read as "-81% impressions" and, because
    //    self-benchmarks compare against own history, punished the site TWICE
    //    (movement AND level). Null the running month for sums so the engine's
    //    lastReal() scores the last COMPLETE month; rates/averages/positions
    //    stay (a mid-month average is a valid estimate).
    // 2. All-zero series: a source that only ever reported 0 is UNCONFIGURED,
    //    not measured-at-zero (Briarwood's GA4 had no key events → conversions
    //    scored 0 against a cohort benchmark). Drop the key → unmeasured.
    const SUM_KEYS = new Set([
      'gsc_impressions', 'gsc_clicks', 'bing_impressions', 'bing_clicks',
      'gbp_impressions', 'gbp_impr_maps', 'gbp_impr_search', 'gbp_calls',
      'gbp_directions', 'gbp_website_clicks', 'gbp_posts',
      'ga_sessions', 'ga_users', 'ga_new_users', 'ga_conversions',
      'form_submissions', 'content_pageviews',
    ]);
    const curIdx = months - 1;
    for (const key of Object.keys(metrics)) {
      if (SUM_KEYS.has(key)) metrics[key][curIdx] = null;
      const vals = metrics[key].filter((v) => v != null);
      if (!vals.length || vals.every((v) => v === 0)) delete metrics[key];
    }

    // Industry benchmark ladder (2026-07-26) — researched per-vertical
    // benchmarks resolved detail→medium→high→default; the Portal catalog
    // overrides its hardcoded defaults with these.
    let benchmarks = {};
    try {
      const { resolveBenchmarks } = await import('./benchmarks.js');
      benchmarks = (await resolveBenchmarks(pool, site.tenant_id)).benchmarks;
    } catch (e) { console.warn('[arionMetrics] benchmark ladder skipped:', e.message); }

    // Detail layer — per-keyword monthly positions (metric_key 'kw_position',
    // dimension 'keyword') → the Keyword Movement detail report, so the deep
    // report runs on REAL line items in prod, not just the aggregate series.
    const detail = {};
    try {
      const d = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('n', sql.Int, months)
        .query(`SELECT dimension_value kw, period_month, value
                FROM arion.metric_monthly
                WHERE site_id = @siteId AND metric_key = 'kw_position' AND dimension = 'keyword'
                  AND period_month >= DATEADD(month, -@n, DATEFROMPARTS(YEAR(GETUTCDATE()), MONTH(GETUTCDATE()), 1))
                ORDER BY period_month`);
      if (d.recordset.length) {
        const byKw = new Map();
        for (const row of d.recordset) {
          const i = idxOf.get(row.period_month.toISOString().slice(0, 7));
          if (i == null) continue;
          if (!byKw.has(row.kw)) byKw.set(row.kw, new Array(months).fill(null));
          byKw.get(row.kw)[i] = Number(row.value);
        }
        detail.keyword_movement = {
          id: 'keyword_movement',
          section: 'search_visibility.keyword_rankings',
          label: 'Keyword Movement',
          itemLabel: 'Keyword',
          primaryLabel: 'Position',
          format: 'position',
          higherIsBetter: false,
          items: [...byKw.entries()].map(([name, series]) => ({ name, series })),
        };
      }
    } catch { /* detail is additive — the aggregate payload still serves */ }

    return { source: 'prod', months: monthLabels, metrics, detail, benchmarks };
  } catch (e) {
    return { source: 'prod', months: monthLabels, metrics: {}, error: e.message };
  }
}
