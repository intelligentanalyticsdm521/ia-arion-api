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
    // Real stored rows beat demo (same rule as demoData.js: a genuinely
    // connected site always wins). Dev-only branch — the flag is never set
    // in prod, so prod never runs this query.
    const stored = await pool.request()
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .query(`SELECT TOP 1 1 AS x FROM arion.metric_monthly WHERE site_id = @siteId`);
    if (!stored.recordset.length) {
      return { source: 'demo', months: monthLabels, metrics: demoArionMetrics(site), detail: demoArionDetail(site) };
    }
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

    // Detail layer (Ingestion Phase 2, 2026-07-26) — GENERIC assembly: every
    // dimensioned metric family becomes a real detail report with line items.
    // Report ids/sections mirror the demo catalog (arionDetail.js) exactly so
    // the Portal's sections pick them up unchanged; extras join the latest
    // month of sibling metrics on the same dimension value.
    const DIM_REPORTS = [
      { id: 'keyword_movement', section: 'search_visibility.keyword_rankings', label: 'Keyword Movement', itemLabel: 'Keyword', primaryLabel: 'Position', format: 'position', hib: false, metric: 'kw_position', extras: [{ metric: 'kw_volume', key: 'volume', label: 'Volume', format: 'number' }, { metric: 'kw_cpc', key: 'cpc', label: 'CPC', format: 'currency' }] },
      { id: 'query_performance', section: 'search_visibility.search_traffic', label: 'Query Performance', itemLabel: 'Query', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_query_clicks', extras: [{ metric: 'gsc_query_impressions', key: 'impressions', label: 'Impressions', format: 'number' }, { metric: 'gsc_query_position', key: 'position', label: 'Avg Position', format: 'position' }] },
      { id: 'page_search_performance', section: 'search_visibility.search_traffic', label: 'Landing Page Search Performance', itemLabel: 'Page', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_page_clicks', extras: [{ metric: 'gsc_page_impressions', key: 'impressions', label: 'Impressions', format: 'number' }, { metric: 'gsc_page_position', key: 'position', label: 'Avg Position', format: 'position' }] },
      { id: 'search_device_split', section: 'search_visibility.search_traffic', label: 'Search by Device', itemLabel: 'Device', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_device_clicks', extras: [{ metric: 'gsc_device_impressions', key: 'impressions', label: 'Impressions', format: 'number' }] },
      { id: 'referring_domains', section: 'search_visibility.domain_authority', label: 'Referring Domains', itemLabel: 'Domain', primaryLabel: 'Backlinks', format: 'number', hib: true, metric: 'rd_backlinks' },
      { id: 'gbp_search_keywords', section: 'local_presence.discovery', label: 'Listing Search Terms', itemLabel: 'Search term', primaryLabel: 'Impressions', format: 'number', hib: true, metric: 'gbp_search_keyword_impressions' },
      { id: 'channel_breakdown', section: 'audience_conversion.traffic_volume', label: 'Traffic by Channel', itemLabel: 'Channel', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_channel_sessions' },
      { id: 'referral_sources', section: 'audience_conversion.traffic_volume', label: 'Referral Sources', itemLabel: 'Source', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_source_sessions' },
      { id: 'device_breakdown', section: 'audience_conversion.audience_mix', label: 'Sessions by Device', itemLabel: 'Device', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_device_sessions' },
      { id: 'geography', section: 'audience_conversion.audience_mix', label: 'Sessions by City', itemLabel: 'City', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_city_sessions' },
      { id: 'engagement_by_channel', section: 'audience_conversion.engagement_quality', label: 'Engagement by Channel', itemLabel: 'Channel', primaryLabel: 'Engagement Rate', format: 'percent', hib: true, metric: 'ga_channel_engagement' },
      { id: 'engagement_by_page', section: 'audience_conversion.engagement_quality', label: 'Engagement by Landing Page', itemLabel: 'Page', primaryLabel: 'Engagement Rate', format: 'percent', hib: true, metric: 'ga_page_engagement' },
      { id: 'top_pages', section: 'content.page_performance', label: 'Top Pages', itemLabel: 'Page', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_page_sessions' },
      { id: 'conversion_by_source', section: 'audience_conversion.conversions', label: 'Conversions by Source', itemLabel: 'Source', primaryLabel: 'Conversions', format: 'number', hib: true, metric: 'ga_conv_by_source' },
    ];
    const detail = {};
    try {
      const d = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('n', sql.Int, months)
        .query(`SELECT metric_key, dimension_value dv, period_month, value
                FROM arion.metric_monthly
                WHERE site_id = @siteId AND dimension IS NOT NULL
                  AND period_month >= DATEADD(month, -@n, DATEFROMPARTS(YEAR(GETUTCDATE()), MONTH(GETUTCDATE()), 1))
                ORDER BY period_month`);
      // metric_key → Map(dimension_value → series)
      const byMetric = new Map();
      for (const row of d.recordset) {
        const i = idxOf.get(row.period_month.toISOString().slice(0, 7));
        if (i == null) continue;
        if (!byMetric.has(row.metric_key)) byMetric.set(row.metric_key, new Map());
        const m = byMetric.get(row.metric_key);
        if (!m.has(row.dv)) m.set(row.dv, new Array(months).fill(null));
        m.get(row.dv)[i] = Number(row.value);
      }
      const latestOf = (metric, dv) => {
        const s = byMetric.get(metric)?.get(dv);
        if (!s) return null;
        for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i];
        return null;
      };
      // ── Bespoke computed reports (beyond 1:1 dimension mapping) ──────────
      // ctr_by_query (TREND): per-query monthly CTR from the clicks +
      // impressions dim families.
      const qClicks = byMetric.get('gsc_query_clicks');
      const qImpr = byMetric.get('gsc_query_impressions');
      const qPos = byMetric.get('gsc_query_position');
      const lastOf = (s) => { if (!s) return null; for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]; return null; };
      if (qClicks && qImpr) {
        const items = [];
        for (const [name, cSeries] of qClicks) {
          const iSeries = qImpr.get(name);
          if (!iSeries) continue;
          const ctr = cSeries.map((c, i) => (c != null && iSeries[i] > 0 ? Number(((c / iSeries[i]) * 100).toFixed(2)) : null));
          if (!ctr.some((v) => v != null)) continue;
          const extra = {};
          const p = lastOf(qPos?.get(name));
          if (p != null) extra.position = p;
          const im = lastOf(iSeries);
          if (im != null) extra.impressions = im;
          items.push({ name, series: ctr, ...(Object.keys(extra).length ? { extra } : {}) });
        }
        if (items.length) {
          detail.ctr_by_query = {
            id: 'ctr_by_query', section: 'search_visibility.click_through', label: 'Click-Through by Query',
            itemLabel: 'Query', primaryLabel: 'CTR', format: 'percent', higherIsBetter: true,
            columns: [{ key: 'position', label: 'Avg Position', format: 'position' }, { key: 'impressions', label: 'Impressions', format: 'number' }],
            items,
          };
        }

        // ctr_opportunity (INTELLIGENCE): actual CTR vs the expected-CTR-at-
        // position curve (model-tier benchmark rows, researched + AI-Overview-
        // adjusted). Ranked by potential extra clicks — the title/meta
        // rewrite list. Passed through into the Intelligence funnel.
        try {
          const curveRows = (await pool.request().query(`
            SELECT metric_key, benchmark_value FROM arion.ia_insights_benchmark
            WHERE tier = 'model' AND metric_key LIKE 'serp_ctr_p%'`)).recordset;
          const curve = [];
          for (const r of curveRows) {
            const pos = Number(String(r.metric_key).replace('serp_ctr_p', ''));
            if (isFinite(pos)) curve.push({ pos, ctr: Number(r.benchmark_value) });
          }
          curve.sort((a, b) => a.pos - b.pos);
          const expectedCtr = (pos) => {
            if (!curve.length || pos == null) return null;
            if (pos <= curve[0].pos) return curve[0].ctr;
            for (let i = 1; i < curve.length; i++) {
              if (pos <= curve[i].pos) {
                const a = curve[i - 1], b = curve[i];
                return a.ctr + ((pos - a.pos) / (b.pos - a.pos)) * (b.ctr - a.ctr);
              }
            }
            return pos <= 20 ? curve[curve.length - 1].ctr * (10 / pos) : null;
          };
          const opp = [];
          for (const [name, cSeries] of qClicks) {
            const iSeries = qImpr.get(name);
            const pos = lastOf(qPos?.get(name));
            const impr = lastOf(iSeries);
            const clicks = lastOf(cSeries);
            if (pos == null || impr == null || impr < 20 || pos > 20) continue;
            const actual = impr > 0 ? ((clicks || 0) / impr) * 100 : 0;
            const expected = expectedCtr(pos);
            if (expected == null || actual >= expected * 0.7) continue;
            const potential = Math.round(((expected - actual) / 100) * impr);
            if (potential < 1) continue;
            const ctrSeries = cSeries.map((c, i) => (c != null && iSeries[i] > 0 ? Number(((c / iSeries[i]) * 100).toFixed(2)) : null));
            opp.push({
              name, series: ctrSeries,
              extra: {
                position: pos, impressions: impr,
                actualCtr: Number(actual.toFixed(2)), expectedCtr: Number(expected.toFixed(2)),
                potential,
              },
              momPct: null,
            });
          }
          if (opp.length) {
            opp.sort((a, b) => (b.extra.potential || 0) - (a.extra.potential || 0));
            detail.ctr_opportunity = {
              id: 'ctr_opportunity', section: 'visibility_trajectory.ranking_opportunities', label: 'CTR Opportunity — Title & Meta Rewrites',
              itemLabel: 'Query', primaryLabel: 'CTR', format: 'percent', higherIsBetter: true,
              columns: [
                { key: 'position', label: 'Position', format: 'position' },
                { key: 'impressions', label: 'Impressions', format: 'number' },
                { key: 'expectedCtr', label: 'Expected CTR', format: 'percent' },
                { key: 'potential', label: 'Potential +clicks/mo', format: 'number' },
              ],
              items: opp.slice(0, 25),
            };
          }
        } catch { /* model rows missing — report simply doesn't render */ }
      }

      // trend_breaks (INTELLIGENCE): changepoint detection — for each key
      // series, find the month where the level genuinely SHIFTED (max
      // standardized before/after mean split, ≥25% relative change, ≥3
      // months each side). This is the "your traffic broke trend in March"
      // report — it ties dips to events (migrations, algorithm updates).
      try {
        const SCAN = [
          ['ga_sessions', 'Website Sessions'], ['gsc_clicks', 'Search Clicks'],
          ['gsc_impressions', 'Search Impressions'], ['gbp_impressions', 'Listing Impressions'],
          ['gbp_calls', 'Calls from Google'], ['kw_top10', 'Top-10 Keywords'],
          ['content_pageviews', 'Page Views'],
        ];
        const breaks = [];
        for (const [key, label] of SCAN) {
          const s = (metrics[key] || []).map((v) => (v != null && isFinite(v) ? v : null));
          const vals = s.filter((v) => v != null);
          if (vals.length < 7) continue;
          const clean = s.map((v) => v); // keep month alignment
          let best = null;
          for (let t = 3; t <= clean.length - 3; t++) {
            const before = clean.slice(0, t).filter((v) => v != null);
            const after = clean.slice(t).filter((v) => v != null);
            if (before.length < 3 || after.length < 3) continue;
            const mb = before.reduce((a, b) => a + b, 0) / before.length;
            const ma = after.reduce((a, b) => a + b, 0) / after.length;
            if (mb === 0) continue;
            const rel = ((ma - mb) / Math.abs(mb)) * 100;
            const sd = Math.sqrt(before.reduce((a, b) => a + (b - mb) ** 2, 0) / before.length) || 1;
            const score = Math.abs(ma - mb) / sd;
            if (Math.abs(rel) >= 25 && (!best || score > best.score)) best = { t, rel, mb, ma, score };
          }
          if (best) {
            breaks.push({
              name: label, series: s,
              extra: {
                breakMonth: monthLabels[best.t] || '',
                beforeAvg: Math.round(best.mb), afterAvg: Math.round(best.ma),
                changePct: Number(best.rel.toFixed(0)),
              },
            });
          }
        }
        if (breaks.length) {
          breaks.sort((a, b) => Math.abs(b.extra.changePct) - Math.abs(a.extra.changePct));
          detail.trend_breaks = {
            id: 'trend_breaks', section: 'visibility_trajectory.search_anomalies', label: 'Trend Breaks — When Things Changed',
            itemLabel: 'Metric', primaryLabel: 'Monthly value', format: 'number', higherIsBetter: true,
            columns: [
              { key: 'breakMonth', label: 'Broke in', format: 'text' },
              { key: 'beforeAvg', label: 'Avg before', format: 'number' },
              { key: 'afterAvg', label: 'Avg after', format: 'number' },
              { key: 'changePct', label: 'Shift %', format: 'percent' },
            ],
            items: breaks,
          };
        }
      } catch { /* additive */ }

      for (const def of DIM_REPORTS) {
        const m = byMetric.get(def.metric);
        if (!m || !m.size) continue;
        const columns = (def.extras || []).map((x) => ({ key: x.key, label: x.label, format: x.format }));
        detail[def.id] = {
          id: def.id, section: def.section, label: def.label,
          itemLabel: def.itemLabel, primaryLabel: def.primaryLabel,
          format: def.format, higherIsBetter: def.hib,
          ...(columns.length ? { columns } : {}),
          items: [...m.entries()].map(([name, series]) => {
            const extra = {};
            for (const x of def.extras || []) {
              const v = latestOf(x.metric, name);
              if (v != null) extra[x.key] = v;
            }
            return { name, series, ...(Object.keys(extra).length ? { extra } : {}) };
          }),
        };
      }

      // striking_distance (2026-07-26, Brandon walk): keywords sitting at
      // position 11–20 — page two, one push from page one. Same kw_position
      // dim family as keyword_movement, filtered to the striking band and
      // ranked by search volume so the list reads as a work queue.
      const kwPos = byMetric.get('kw_position');
      if (kwPos && kwPos.size) {
        const sd = [];
        for (const [name, series] of kwPos) {
          const cur = lastOf(series);
          if (cur == null || cur < 11 || cur > 20) continue;
          const extra = {};
          const vol = latestOf('kw_volume', name);
          const cpc = latestOf('kw_cpc', name);
          if (vol != null) extra.volume = vol;
          if (cpc != null) extra.cpc = cpc;
          sd.push({ name, series, ...(Object.keys(extra).length ? { extra } : {}) });
        }
        if (sd.length) {
          sd.sort((a, b) => (b.extra?.volume || 0) - (a.extra?.volume || 0));
          detail.striking_distance = {
            id: 'striking_distance', section: 'search_visibility.keyword_rankings', label: 'Striking Distance — One Push from Page One',
            itemLabel: 'Keyword', primaryLabel: 'Position', format: 'position', higherIsBetter: false,
            columns: [
              { key: 'volume', label: 'Monthly searches', format: 'number' },
              { key: 'cpc', label: 'CPC value', format: 'currency' },
            ],
            items: sd,
          };
        }
      }
    } catch { /* detail is additive — the aggregate payload still serves */ }

    return { source: 'prod', months: monthLabels, metrics, detail, benchmarks };
  } catch (e) {
    return { source: 'prod', months: monthLabels, metrics: {}, error: e.message };
  }
}
