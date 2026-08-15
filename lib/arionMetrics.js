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

  // ── SOFTWARE UPKEEP (2026-08-14) ──
  // A believable maintenance story: the update backlog CREEPS UP over the year
  // (nobody patches until something forces it), core health slowly improves,
  // and missing meta drifts down as content gets cleaned up. Demo data has to
  // be plausible, not flattering — a site with 0 pending updates all year would
  // make the whole report look decorative.
  M.upkeep_updates_pending    = series(R('upd'), 4, { drift: 0.07, noise: 0.25, dir: 1, integer: true, min: 0 });
  M.upkeep_components_total   = series(R('comp'), 18, { drift: 0.004, noise: 0.02, integer: true });
  M.upkeep_health_critical    = series(R('hcrit'), 1, { drift: -0.04, noise: 0.4, integer: true, min: 0 });
  M.upkeep_health_recommended = series(R('hrec'), 4, { drift: -0.02, noise: 0.2, integer: true, min: 0 });
  M.upkeep_meta_missing       = series(R('meta'), 22, { drift: -0.03, noise: 0.08, integer: true, min: 0 });
  M.upkeep_seo_score          = series(R('rmseo'), 62, { drift: 0.01, noise: 0.04, dir: 1 }).map((v) => Number(Math.min(100, v).toFixed(1)));
  M.upkeep_core_behind        = M.upkeep_updates_pending.map((v) => (v > 8 ? 1 : 0));
  M.upkeep_theme_behind       = M.upkeep_updates_pending.map((v) => (v > 6 ? 1 : 0));

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

      // ── 2026-08-14: reports over the newly captured dimensions ───────────
      // Every one of these reads data the integrations now pull and previously
      // did not. They are declarations, not new machinery — the generator above
      // already turns a metric key plus its companions into a full report.

      // Search Console
      { id: 'search_by_country', section: 'search_visibility.search_traffic', label: 'Search Traffic by Country', itemLabel: 'Country', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_country_clicks',
        extras: [{ metric: 'gsc_country_impressions', key: 'impressions', label: 'Impressions', format: 'number' }] },
      // page × query — the only place that answers "which search brought
      // someone to THIS page", which is the question behind every content call.
      { id: 'page_query_pairs', section: 'search_visibility.search_traffic', label: 'Which Search Brings Them to Which Page', itemLabel: 'Page + search', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_pagequery_clicks',
        extras: [{ metric: 'gsc_pagequery_impressions', key: 'impressions', label: 'Impressions', format: 'number' }, { metric: 'gsc_pagequery_position', key: 'position', label: 'Avg Position', format: 'position' }] },
      { id: 'search_appearance', section: 'search_visibility.search_traffic', label: 'Rich Result Types You Earn', itemLabel: 'Appearance', primaryLabel: 'Clicks', format: 'number', hib: true, metric: 'gsc_appearance_clicks',
        extras: [{ metric: 'gsc_appearance_impressions', key: 'impressions', label: 'Impressions', format: 'number' }] },

      // GA4 — audience
      { id: 'audience_by_country', section: 'audience_conversion.audience_mix', label: 'Visitors by Country', itemLabel: 'Country', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_country_sessions',
        extras: [{ metric: 'ga_country_users', key: 'users', label: 'Users', format: 'number' }, { metric: 'ga_country_new_users', key: 'new_users', label: 'New users', format: 'number' }, { metric: 'ga_country_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }] },
      // Bounce rate BY BROWSER is how a broken browser gets found. Nothing else
      // tells an owner "Safari users leave immediately and Chrome users do not".
      { id: 'browser_experience', section: 'audience_conversion.audience_mix', label: 'Experience by Browser', itemLabel: 'Browser', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_browser_sessions',
        extras: [{ metric: 'ga_browser_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }, { metric: 'ga_browser_avg_duration', key: 'duration', label: 'Avg seconds', format: 'number' }, { metric: 'ga_browser_pageviews', key: 'pageviews', label: 'Pageviews', format: 'number' }] },
      { id: 'device_os_split', section: 'audience_conversion.audience_mix', label: 'Experience by Operating System', itemLabel: 'OS', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_os_sessions',
        extras: [{ metric: 'ga_os_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }, { metric: 'ga_os_avg_duration', key: 'duration', label: 'Avg seconds', format: 'number' }] },
      { id: 'new_vs_returning', section: 'audience_conversion.audience_mix', label: 'New Visitors vs People Coming Back', itemLabel: 'Visitor type', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_visitor_sessions',
        extras: [{ metric: 'ga_visitor_users', key: 'users', label: 'Users', format: 'number' }, { metric: 'ga_visitor_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }, { metric: 'ga_visitor_avg_duration', key: 'duration', label: 'Avg seconds', format: 'number' }] },
      // 24 rows, and the answer to "when should someone be answering the phone".
      { id: 'traffic_by_hour', section: 'audience_conversion.traffic_volume', label: 'When People Actually Visit', itemLabel: 'Hour', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_hour_sessions',
        extras: [{ metric: 'ga_hour_users', key: 'users', label: 'Users', format: 'number' }, { metric: 'ga_hour_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }] },
      { id: 'traffic_by_medium', section: 'audience_conversion.traffic_volume', label: 'Traffic by Medium', itemLabel: 'Medium', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_medium_sessions',
        extras: [{ metric: 'ga_medium_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }, { metric: 'ga_medium_new_users', key: 'new_users', label: 'New users', format: 'number' }] },
      { id: 'campaign_performance', section: 'audience_conversion.traffic_volume', label: 'Campaign Performance', itemLabel: 'Campaign', primaryLabel: 'Sessions', format: 'number', hib: true, metric: 'ga_campaign_sessions',
        extras: [{ metric: 'ga_campaign_users', key: 'users', label: 'Users', format: 'number' }, { metric: 'ga_campaign_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }, { metric: 'ga_campaign_avg_duration', key: 'duration', label: 'Avg seconds', format: 'number' }] },
      { id: 'page_titles_read', section: 'content.page_performance', label: 'What People Actually Read', itemLabel: 'Page', primaryLabel: 'Pageviews', format: 'number', hib: true, metric: 'ga_title_pageviews',
        extras: [{ metric: 'ga_title_sessions', key: 'sessions', label: 'Sessions', format: 'number' }, { metric: 'ga_title_avg_duration', key: 'duration', label: 'Avg seconds', format: 'number' }, { metric: 'ga_title_bounce_rate', key: 'bounce', label: 'Bounce %', format: 'percent' }] },

      // NOTE: the GBP device x surface split is NOT here. This generator keys on
      // dimension_value, and the four impression metrics are scalars — declaring
      // one would render an empty report. It is built explicitly below instead.
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
      // Running-month guard for DIMS (2026-07-26): sum-type dimension series
      // must null the current (incomplete) month, same rule as the overall
      // series — otherwise every report card reads "31 → 2 (-94%)" mid-month.
      // Point-in-time families (position/volume/cpc/rating/engagement) keep
      // their current-month snapshot.
      const POINT_IN_TIME = /position|volume|cpc|rating|engagement/;
      const curIdx = months - 1;
      for (const [mk, m] of byMetric) {
        if (POINT_IN_TIME.test(mk)) continue;
        for (const s of m.values()) if (curIdx >= 0 && curIdx < s.length) s[curIdx] = null;
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

    // -- Content Library (2026-08-14) ---------------------------------------
    // Brandon: "this software acts as the first line of consulting. If I were
    // to come in and analyze someone site these are things I would review."
    //
    // The Content dashboard has ALWAYS declared content_fresh_ratio,
    // content_avg_age_days, content_rankmath_avg, content_avg_words and
    // content_thin_ratio -- and never had a source. arion.site_content_item
    // (migration 048) is that source, so the dashboard lights up without a
    // single new section.
    //
    // Monthly series = the LAST capture in each month, so a month reads as the
    // state the site was actually left in, not a mid-month sample.
    try {
      const idxOfMonth = new Map(monthLabels.map((l, i) => [l, i]));
      const ci = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH latest_per_month AS (
            SELECT ym = FORMAT(snapshot_date, 'yyyy-MM'), d = MAX(snapshot_date)
              FROM arion.site_content_item
             WHERE site_id = @siteId
               AND snapshot_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
             GROUP BY FORMAT(snapshot_date, 'yyyy-MM')
          )
          SELECT lpm.ym,
                 pages     = COUNT(*),
                 avg_seo   = AVG(CAST(NULLIF(c.seo_score, 0) AS float)),
                 avg_words = AVG(CAST(c.word_count AS float)),
                 thin      = SUM(CASE WHEN c.word_count < 300 THEN 1 ELSE 0 END),
                 fresh     = SUM(CASE WHEN c.last_modified >= DATEADD(day, -90, c.snapshot_date) THEN 1 ELSE 0 END),
                 avg_age   = AVG(CAST(DATEDIFF(day, c.last_modified, c.snapshot_date) AS float))
            FROM arion.site_content_item c
            JOIN latest_per_month lpm
              ON lpm.d = c.snapshot_date
             AND lpm.ym = FORMAT(c.snapshot_date, 'yyyy-MM')
           WHERE c.site_id = @siteId
           GROUP BY lpm.ym`);

      if (ci.recordset.length) {
        const putC = (key, ym, val) => {
          const i = idxOfMonth.get(ym);
          if (i == null || val == null) return;
          const arr = metrics[key] || new Array(months).fill(null);
          arr[i] = Number(Number(val).toFixed(2));
          metrics[key] = arr;
        };
        for (const row of ci.recordset) {
          const pages = Number(row.pages) || 0;
          putC('content_rankmath_avg', row.ym, row.avg_seo);
          putC('content_avg_words', row.ym, row.avg_words);
          putC('content_avg_age_days', row.ym, row.avg_age);
          if (pages > 0) {
            putC('content_thin_ratio', row.ym, (Number(row.thin) / pages) * 100);
            putC('content_fresh_ratio', row.ym, (Number(row.fresh) / pages) * 100);
          }
        }
      }

      // The detail report -- one row per page, series = WORD COUNT so the depth
      // bands the plugin already uses (thin / standard / long / pillar) carry
      // straight through. SEO score is a COLUMN rather than the series because
      // Rank Math leaves it 0 on sites that never configured it (2 of our 4),
      // and a report whose primary metric is mostly zero reads as broken.
      const pagesRes = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH ranked AS (
            SELECT c.*, ym = FORMAT(c.snapshot_date, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (
                          PARTITION BY c.post_id, FORMAT(c.snapshot_date, 'yyyy-MM')
                          ORDER BY c.snapshot_date DESC)
              FROM arion.site_content_item c
             WHERE c.site_id = @siteId
               AND c.snapshot_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
          )
          SELECT post_id, ym, title, url_path, post_type, seo_score, focus_keyword,
                 has_meta_desc, schema_type, readability, word_count, is_noindex, last_modified
            FROM ranked WHERE rn = 1
           ORDER BY post_id, ym`);

      if (pagesRes.recordset.length) {
        const byPost = new Map();
        for (const row of pagesRes.recordset) {
          if (!byPost.has(row.post_id)) byPost.set(row.post_id, { latest: row, months: new Map() });
          const rec = byPost.get(row.post_id);
          rec.months.set(row.ym, row);
          rec.latest = row;                       // ORDER BY ym asc -> last wins
        }

        // Cannibalisation is computable right here: two pages declaring the same
        // focus keyword are competing with each other, and the owner has no way
        // to see that anywhere in WordPress.
        const kwCount = new Map();
        for (const rec of byPost.values()) {
          const k = String(rec.latest.focus_keyword || '').trim().toLowerCase();
          if (k) kwCount.set(k, (kwCount.get(k) || 0) + 1);
        }

        const items = [...byPost.values()].map((rec) => {
          const latest = rec.latest;
          const series = new Array(monthLabels.length).fill(null);
          for (const [ym, row] of rec.months) {
            const i = idxOfMonth.get(ym);
            if (i != null) series[i] = row.word_count == null ? null : Number(row.word_count);
          }
          const kw = String(latest.focus_keyword || '').trim().toLowerCase();
          const daysSince = latest.last_modified
            ? Math.round((Date.now() - new Date(latest.last_modified).getTime()) / 86400000)
            : null;
          return {
            name: latest.title || latest.url_path || ('Post ' + latest.post_id),
            series,
            extra: {
              path: latest.url_path || '-',
              type: latest.post_type || '-',
              seo: latest.seo_score == null ? 0 : Number(latest.seo_score),
              words: latest.word_count == null ? 0 : Number(latest.word_count),
              focus_keyword: latest.focus_keyword || '-',
              meta: latest.has_meta_desc ? 'Yes' : 'Missing',
              schema: latest.schema_type || 'none',
              readability: latest.readability == null ? 0 : Number(latest.readability),
              days_since_update: daysSince == null ? 0 : daysSince,
              noindex: latest.is_noindex ? 1 : 0,
              competing: kw ? (kwCount.get(kw) || 1) : 1,
            },
          };
        });

        detail.content_library = {
          id: 'content_library',
          section: 'content.content_quality',
          label: 'Content Library - Every Page, Reviewed',
          itemLabel: 'Page',
          primaryLabel: 'Words',
          format: 'number',
          higherIsBetter: true,
          columns: [
            { key: 'type', label: 'Type', format: 'text' },
            // No 'words' column — the primary value column already IS the word
            // count, and printing it twice on every row just reads as a bug.
            { key: 'seo', label: 'SEO score', format: 'number' },
            { key: 'meta', label: 'Meta description', format: 'text' },
            { key: 'focus_keyword', label: 'Focus keyword', format: 'text' },
            { key: 'days_since_update', label: 'Days since update', format: 'number' },
          ],
          items: items.sort((a, b) => Number(a.extra.words) - Number(b.extra.words)),
        };
      }
    } catch (e) {
      console.warn('[arionMetrics] content library skipped:', e.message);
    }

    // -- Page Reachability + Media Library (2026-08-14, plugin v1.4.0) ------
    // The two questions WordPress cannot answer about a site it is running.
    try {
      const idxOfMonth2 = new Map(monthLabels.map((l, i) => [l, i]));

      // ── page reachability ───────────────────────────────────────────────
      // Series is INBOUND LINKS, because that is the thing that decides whether
      // a page is reachable at all. A page nothing links to and no menu points
      // at exists only for whoever already has the URL.
      const lk = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH ranked AS (
            SELECT l.*, ym = FORMAT(l.snapshot_date, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (
                          PARTITION BY l.post_id, FORMAT(l.snapshot_date, 'yyyy-MM')
                          ORDER BY l.snapshot_date DESC)
              FROM arion.site_page_link l
             WHERE l.site_id = @siteId
               AND l.snapshot_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
          )
          SELECT post_id, ym, title, url_path, links_out, links_out_external,
                 links_in, in_menu, is_orphan, to_missing, to_unpublished, to_missing_paths
            FROM ranked WHERE rn = 1
           ORDER BY post_id, ym`);

      if (lk.recordset.length) {
        const byPost = new Map();
        for (const row of lk.recordset) {
          if (!byPost.has(row.post_id)) byPost.set(row.post_id, { latest: row, months: new Map() });
          const rec = byPost.get(row.post_id);
          rec.months.set(row.ym, row);
          rec.latest = row;
        }

        const items = [...byPost.values()].map((rec) => {
          const latest = rec.latest;
          const series = new Array(monthLabels.length).fill(null);
          for (const [ym, row] of rec.months) {
            const i = idxOfMonth2.get(ym);
            if (i != null) series[i] = row.links_in == null ? null : Number(row.links_in);
          }
          let missing = [];
          try { missing = JSON.parse(latest.to_missing_paths || '[]'); } catch { missing = []; }
          return {
            name: latest.title || latest.url_path || ('Post ' + latest.post_id),
            series,
            extra: {
              path: latest.url_path || '-',
              links_in: Number(latest.links_in || 0),
              links_out: Number(latest.links_out || 0),
              links_out_external: Number(latest.links_out_external || 0),
              in_menu: latest.in_menu ? 'Yes' : 'No',
              orphan: latest.is_orphan ? 1 : 0,
              to_missing: Number(latest.to_missing || 0),
              to_unpublished: Number(latest.to_unpublished || 0),
              // The paths themselves, so "11 broken links" is a fix list rather
              // than a number to go hunting for.
              missing_paths: missing.slice(0, 6).join(', ') || '-',
            },
          };
        });

        detail.page_reachability = {
          id: 'page_reachability',
          section: 'content.content_quality',
          label: 'Page Reachability - Can Anyone Find This?',
          itemLabel: 'Page',
          primaryLabel: 'Links in',
          format: 'number',
          higherIsBetter: true,
          columns: [
            { key: 'links_in', label: 'Links in', format: 'number' },
            { key: 'links_out', label: 'Links out', format: 'number' },
            { key: 'in_menu', label: 'In menu', format: 'text' },
            { key: 'to_missing', label: 'Broken links', format: 'number' },
            { key: 'missing_paths', label: 'Pointing at', format: 'text' },
          ],
          items: items.sort((a, b) => Number(a.extra.links_in) - Number(b.extra.links_in)),
        };

        // Site-level metrics so the Content dashboard can score reachability.
        const latestDay = await pool.request()
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query(`
            SELECT ym = FORMAT(snapshot_date, 'yyyy-MM'),
                   pages = COUNT(*),
                   orphans = SUM(CASE WHEN is_orphan = 1 THEN 1 ELSE 0 END),
                   avg_in = AVG(CAST(links_in AS float)),
                   broken = SUM(CAST(ISNULL(to_missing, 0) AS int))
              FROM arion.site_page_link
             WHERE site_id = @siteId
               AND snapshot_date IN (
                 SELECT MAX(snapshot_date) FROM arion.site_page_link
                  WHERE site_id = @siteId
                  GROUP BY FORMAT(snapshot_date, 'yyyy-MM'))
             GROUP BY FORMAT(snapshot_date, 'yyyy-MM')`);
        for (const row of latestDay.recordset) {
          const i = idxOfMonth2.get(row.ym);
          if (i == null) continue;
          const pages = Number(row.pages) || 0;
          const put = (k, v) => {
            if (v == null) return;
            const arr = metrics[k] || new Array(months).fill(null);
            arr[i] = Number(Number(v).toFixed(2));
            metrics[k] = arr;
          };
          put('content_avg_links_in', row.avg_in);
          put('content_broken_links', row.broken);
          if (pages > 0) put('content_orphan_ratio', (Number(row.orphans) / pages) * 100);
        }
      }

      // ── media library ───────────────────────────────────────────────────
      // Series is FILE SIZE. The media library is where small-business sites
      // quietly go slow: a phone photo dropped into a page is 4MB and 4000px
      // wide and nothing in WordPress ever mentions it.
      const md = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH ranked AS (
            SELECT m.*, ym = FORMAT(m.snapshot_date, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (
                          PARTITION BY m.attachment_id, FORMAT(m.snapshot_date, 'yyyy-MM')
                          ORDER BY m.snapshot_date DESC)
              FROM arion.site_media_item m
             WHERE m.site_id = @siteId
               AND m.snapshot_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
          )
          SELECT attachment_id, ym, title, file_path, mime, bytes, width, height,
                 has_alt, is_image, referenced, oversized, uploaded_at
            FROM ranked WHERE rn = 1
           ORDER BY attachment_id, ym`);

      if (md.recordset.length) {
        const byAtt = new Map();
        for (const row of md.recordset) {
          if (!byAtt.has(row.attachment_id)) byAtt.set(row.attachment_id, { latest: row, months: new Map() });
          const rec = byAtt.get(row.attachment_id);
          rec.months.set(row.ym, row);
          rec.latest = row;
        }

        const items = [...byAtt.values()].map((rec) => {
          const latest = rec.latest;
          const series = new Array(monthLabels.length).fill(null);
          for (const [ym, row] of rec.months) {
            const i = idxOfMonth2.get(ym);
            if (i != null) series[i] = row.bytes == null ? null : Math.round(Number(row.bytes) / 1024);
          }
          const kb = latest.bytes == null ? 0 : Math.round(Number(latest.bytes) / 1024);
          return {
            name: latest.title || (latest.file_path || '').split('/').pop() || ('Attachment ' + latest.attachment_id),
            series,
            extra: {
              file: latest.file_path || '-',
              kb,
              mime: (latest.mime || '-').replace('image/', ''),
              dimensions: latest.width && latest.height ? `${latest.width}x${latest.height}` : '-',
              width: Number(latest.width || 0),
              alt: latest.has_alt ? 'Yes' : 'Missing',
              is_image: latest.is_image ? 1 : 0,
              used: latest.referenced ? 'Yes' : 'No',
              oversized: latest.oversized ? 1 : 0,
            },
          };
        });

        detail.media_library = {
          id: 'media_library',
          section: 'content.content_quality',
          label: 'Media Library - Weight, Alt Text and Dead Files',
          itemLabel: 'File',
          primaryLabel: 'Size (KB)',
          format: 'number',
          higherIsBetter: false,
          columns: [
            { key: 'mime', label: 'Type', format: 'text' },
            { key: 'dimensions', label: 'Dimensions', format: 'text' },
            { key: 'alt', label: 'Alt text', format: 'text' },
            { key: 'used', label: 'Used on a page', format: 'text' },
          ],
          items: items.sort((a, b) => Number(b.extra.kb) - Number(a.extra.kb)),
        };

        const mAgg = await pool.request()
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query(`
            SELECT ym = FORMAT(snapshot_date, 'yyyy-MM'),
                   files = COUNT(*),
                   mb = SUM(CAST(ISNULL(bytes,0) AS bigint)) / 1048576.0,
                   no_alt = SUM(CASE WHEN is_image = 1 AND has_alt = 0 THEN 1 ELSE 0 END),
                   images = SUM(CASE WHEN is_image = 1 THEN 1 ELSE 0 END),
                   unused = SUM(CASE WHEN referenced = 0 THEN 1 ELSE 0 END)
              FROM arion.site_media_item
             WHERE site_id = @siteId
               AND snapshot_date IN (
                 SELECT MAX(snapshot_date) FROM arion.site_media_item
                  WHERE site_id = @siteId
                  GROUP BY FORMAT(snapshot_date, 'yyyy-MM'))
             GROUP BY FORMAT(snapshot_date, 'yyyy-MM')`);
        for (const row of mAgg.recordset) {
          const i = idxOfMonth2.get(row.ym);
          if (i == null) continue;
          const put = (k, v) => {
            if (v == null) return;
            const arr = metrics[k] || new Array(months).fill(null);
            arr[i] = Number(Number(v).toFixed(2));
            metrics[k] = arr;
          };
          put('media_library_mb', row.mb);
          put('media_unused_count', row.unused);
          const images = Number(row.images) || 0;
          if (images > 0) put('media_alt_coverage', ((images - Number(row.no_alt)) / images) * 100);
        }
      }
    } catch (e) {
      console.warn('[arionMetrics] link/media reports skipped:', e.message);
    }

    // -- GBP visibility split + PageSpeed vitals (2026-08-14) ---------------
    // Both are built from SCALAR metrics, so each series becomes one ITEM
    // rather than one item per dimension value. The generic dimension
    // generator cannot express that shape.
    try {
      const seriesOf = (key) => {
        const arr = metrics[key];
        return Array.isArray(arr) && arr.some((v) => v != null) ? arr : null;
      };
      const build = (defs) => defs
        .map((d) => ({ name: d.label, series: seriesOf(d.key), extra: d.extra || {} }))
        .filter((it) => it.series);

      // Where the listing is seen. Search vs Maps says which surface to fix;
      // desktop vs mobile says whether the problem is the listing or the site
      // it sends people to. Splitting both ways is the whole point.
      const gbpItems = build([
        { key: 'gbp_impr_mobile_search', label: 'Mobile — Google Search', extra: { surface: 'Search', device: 'Mobile' } },
        { key: 'gbp_impr_mobile_maps', label: 'Mobile — Google Maps', extra: { surface: 'Maps', device: 'Mobile' } },
        { key: 'gbp_impr_desktop_search', label: 'Desktop — Google Search', extra: { surface: 'Search', device: 'Desktop' } },
        { key: 'gbp_impr_desktop_maps', label: 'Desktop — Google Maps', extra: { surface: 'Maps', device: 'Desktop' } },
      ]);
      if (gbpItems.length) {
        detail.gbp_visibility_split = {
          id: 'gbp_visibility_split',
          section: 'local_presence.discovery',
          label: 'Where Your Listing Gets Seen',
          itemLabel: 'Surface',
          primaryLabel: 'Impressions',
          format: 'number',
          higherIsBetter: true,
          columns: [
            { key: 'surface', label: 'Surface', format: 'text' },
            { key: 'device', label: 'Device', format: 'text' },
          ],
          items: gbpItems,
        };
      }

      // What a customer does after finding the listing. Messages and bookings
      // are LEADS and were never even requested from the API until today, so
      // every one of them was invisible.
      const actionItems = build([
        { key: 'gbp_calls', label: 'Called you' },
        { key: 'gbp_directions', label: 'Asked for directions' },
        { key: 'gbp_website_clicks', label: 'Clicked through to the site' },
        { key: 'gbp_conversations', label: 'Sent a message' },
        { key: 'gbp_bookings', label: 'Booked an appointment' },
      ]);
      if (actionItems.length) {
        detail.gbp_actions = {
          id: 'gbp_actions',
          section: 'local_presence.customer_actions',
          label: 'What People Do After Finding You',
          itemLabel: 'Action',
          primaryLabel: 'Times',
          format: 'number',
          higherIsBetter: true,
          items: actionItems,
        };
      }

    } catch (e) {
      console.warn('[arionMetrics] gbp reports skipped:', e.message);
    }

    // -- PageSpeed: Core Web Vitals + the specific fixes ---------------------
    // PageSpeed has been returning all of this since the runner was written and
    // we stored five category scores and threw the rest away — including the
    // three numbers Google actually ranks on, and a list of fixes with the
    // kilobytes each one saves. Read straight from site_pagespeed_snapshot
    // rather than promoting into metric_monthly: the table already holds the
    // per-strategy history, and a promotion step is one more thing to drift.
    try {
      const ps = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH ranked AS (
            SELECT p.*, ym = FORMAT(p.run_date, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (
                          PARTITION BY p.strategy, FORMAT(p.run_date, 'yyyy-MM')
                          ORDER BY p.run_date DESC)
              FROM arion.site_pagespeed_snapshot p
             WHERE p.site_id = @siteId
               AND p.run_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
          )
          SELECT strategy, ym, run_date, lcp_ms, inp_ms, cls_score, fcp_ms, tbt_ms,
                 si_ms, ttfb_ms, performance_score, accessibility_score, seo_score,
                 best_practices_score, opportunities, crux_url_json, crux_origin_json,
                 audits_json, audits_passed, audits_total
            FROM ranked WHERE rn = 1 ORDER BY strategy, ym`);

      if (ps.recordset.length) {
        const idxOfMonth3 = new Map(monthLabels.map((l, i) => [l, i]));
        // One item per measure PER STRATEGY: a phone and a desktop are
        // different experiences and averaging them hides the one that is bad.
        const MEASURES = [
          { col: 'lcp_ms', label: 'Largest Contentful Paint', good: 'under 2.5s', unit: 'ms', scale: 1 },
          { col: 'inp_ms', label: 'Interaction to Next Paint', good: 'under 200ms', unit: 'ms', scale: 1 },
          { col: 'cls_score', label: 'Cumulative Layout Shift', good: 'under 0.1', unit: 'score', scale: 1 },
          { col: 'fcp_ms', label: 'First Contentful Paint', good: 'under 1.8s', unit: 'ms', scale: 1 },
          { col: 'tbt_ms', label: 'Total Blocking Time', good: 'under 200ms', unit: 'ms', scale: 1 },
        ];
        const items = [];
        for (const strat of ['mobile', 'desktop']) {
          const rowsFor = ps.recordset.filter((r) => String(r.strategy) === strat);
          if (!rowsFor.length) continue;
          for (const mdef of MEASURES) {
            const series = new Array(monthLabels.length).fill(null);
            let any = false;
            for (const r of rowsFor) {
              const i2 = idxOfMonth3.get(r.ym);
              if (i2 == null || r[mdef.col] == null) continue;
              series[i2] = Number(Number(r[mdef.col]).toFixed(3));
              any = true;
            }
            if (!any) continue;
            const latest = series.filter((v) => v != null).slice(-1)[0];
            items.push({
              name: `${mdef.label} (${strat})`,
              series,
              extra: {
                strategy: strat,
                good_at: mdef.good,
                unit: mdef.unit,
                // Google's own thresholds, so a row can say pass/fail rather
                // than leaving an owner to interpret a raw millisecond count.
                verdict:
                  mdef.col === 'lcp_ms' ? (latest <= 2500 ? 'Good' : latest <= 4000 ? 'Needs work' : 'Poor')
                  : mdef.col === 'inp_ms' ? (latest <= 200 ? 'Good' : latest <= 500 ? 'Needs work' : 'Poor')
                  : mdef.col === 'cls_score' ? (latest <= 0.1 ? 'Good' : latest <= 0.25 ? 'Needs work' : 'Poor')
                  : mdef.col === 'fcp_ms' ? (latest <= 1800 ? 'Good' : latest <= 3000 ? 'Needs work' : 'Poor')
                  : (latest <= 200 ? 'Good' : latest <= 600 ? 'Needs work' : 'Poor'),
              },
            });
          }
        }
        if (items.length) {
          detail.core_web_vitals = {
            id: 'core_web_vitals',
            section: 'technical.speed_cwv',
            label: 'Core Web Vitals - What Google Actually Measures',
            itemLabel: 'Measure',
            primaryLabel: 'Value',
            format: 'number',
            higherIsBetter: false,
            columns: [
              { key: 'verdict', label: 'Verdict', format: 'text' },
              { key: 'good_at', label: 'Google calls this good at', format: 'text' },
              { key: 'strategy', label: 'Device', format: 'text' },
            ],
            items,
          };
        }

        // ── The audit reports, one per Lighthouse category ────────────────
        // PageSpeed reports four categories, each a list of checks that pass or
        // fail with a weight. We were keeping sixteen performance keys and
        // discarding accessibility, SEO and best practices entirely — which is
        // most of what Google actually says about a site. Migration 051 stores
        // the lot; these turn it into the same four reports Google shows.
        const newestByStrategy = new Map();
        for (const r of ps.recordset) newestByStrategy.set(r.strategy, r);

        const CATEGORIES = [
          { key: 'performance', id: 'pagespeed_performance_audits', label: 'Speed Checks - What Is Slowing the Site Down',
            itemLabel: 'Check', section: 'technical.speed_cwv' },
          { key: 'accessibility', id: 'pagespeed_accessibility_audits', label: 'Accessibility Checks - Who Cannot Use Your Site',
            itemLabel: 'Check', section: 'technical.health_seo' },
          { key: 'seo', id: 'pagespeed_seo_audits', label: 'Technical SEO Checks - What Google Cannot Read',
            itemLabel: 'Check', section: 'technical.health_seo' },
          { key: 'best-practices', id: 'pagespeed_best_practice_audits', label: 'Best Practice Checks - Security and Correctness',
            itemLabel: 'Check', section: 'technical.security' },
        ];

        for (const cat of CATEGORIES) {
          const items = [];
          for (const [strat, row] of newestByStrategy) {
            let all = [];
            try { all = JSON.parse(row.audits_json || '[]'); } catch { all = []; }
            for (const a of all.filter((x) => x.category === cat.key)) {
              // Series carries the Lighthouse weight so the distribution chart
              // separates "costs you a lot" from "technically failing".
              const series = new Array(monthLabels.length).fill(null);
              series[monthLabels.length - 1] = Number(a.weight || 0);
              items.push({
                name: `${a.title}${newestByStrategy.size > 1 ? ` (${strat})` : ''}`,
                series,
                extra: {
                  strategy: strat,
                  impact: Number(a.weight || 0),
                  affected: a.items == null ? '-' : a.items,
                  detail: a.display_value || '-',
                  // Google's own wording for what the check means, so the
                  // report explains itself rather than needing a glossary.
                  what: (a.description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 220),
                },
              });
            }
          }
          if (!items.length) continue;
          detail[cat.id] = {
            id: cat.id, section: cat.section, label: cat.label,
            itemLabel: cat.itemLabel, primaryLabel: 'Impact',
            format: 'number', higherIsBetter: false,
            columns: [
              { key: 'affected', label: 'Elements affected', format: 'text' },
              { key: 'detail', label: 'Google says', format: 'text' },
              { key: 'strategy', label: 'Device', format: 'text' },
              { key: 'what', label: 'What this means', format: 'text' },
            ],
            items: items.sort((a, b) => Number(b.extra.impact) - Number(a.extra.impact)),
          };
        }

        // ── Field data: real visitors, not a lab test ─────────────────────
        // The lab score is one run on Google's hardware. CrUX is what actually
        // happened to real people over 28 days, and it is the number Google
        // uses for ranking. We have been storing it and showing neither.
        const fieldItems = [];
        for (const [strat, row] of newestByStrategy) {
          for (const [col, scope] of [['crux_url_json', 'This page'], ['crux_origin_json', 'Whole site']]) {
            let cx = null;
            try { cx = JSON.parse(row[col] || 'null'); } catch { cx = null; }
            if (!cx) continue;
            for (const [k, label, good] of [
              ['lcp', 'Largest Contentful Paint', 'under 2.5s'],
              ['inp', 'Interaction to Next Paint', 'under 200ms'],
              ['cls', 'Cumulative Layout Shift', 'under 0.1'],
              ['fcp', 'First Contentful Paint', 'under 1.8s'],
            ]) {
              const v = cx[k];
              if (!v || v.percentile == null) continue;
              const series = new Array(monthLabels.length).fill(null);
              series[monthLabels.length - 1] = Number(v.percentile);
              fieldItems.push({
                name: `${label} — ${scope} (${strat})`,
                series,
                extra: {
                  scope, strategy: strat,
                  verdict: v.category === 'FAST' ? 'Good' : v.category === 'AVERAGE' ? 'Needs work' : v.category === 'SLOW' ? 'Poor' : '-',
                  good_at: good,
                },
              });
            }
          }
        }
        if (fieldItems.length) {
          detail.pagespeed_field_data = {
            id: 'pagespeed_field_data',
            section: 'technical.speed_cwv',
            label: 'Real Visitor Speed - What People Actually Experienced',
            itemLabel: 'Measure', primaryLabel: '75th percentile',
            format: 'number', higherIsBetter: false,
            columns: [
              { key: 'verdict', label: 'Verdict', format: 'text' },
              { key: 'good_at', label: 'Google calls this good at', format: 'text' },
              { key: 'scope', label: 'Scope', format: 'text' },
              { key: 'strategy', label: 'Device', format: 'text' },
            ],
            items: fieldItems,
          };
        }

        // ── Category scores over time, the four numbers on the PSI header ──
        const scoreItems = [];
        for (const strat of ['mobile', 'desktop']) {
          const rowsFor = ps.recordset.filter((r) => String(r.strategy) === strat);
          if (!rowsFor.length) continue;
          for (const [col, label] of [
            ['performance_score', 'Performance'], ['accessibility_score', 'Accessibility'],
            ['seo_score', 'SEO'], ['best_practices_score', 'Best Practices'],
          ]) {
            const series = new Array(monthLabels.length).fill(null);
            let any = false;
            for (const r of rowsFor) {
              const i2 = idxOfMonth3.get(r.ym);
              if (i2 == null || r[col] == null) continue;
              series[i2] = Number(r[col]); any = true;
            }
            if (!any) continue;
            const latest = series.filter((v) => v != null).slice(-1)[0];
            const newest = rowsFor[rowsFor.length - 1];
            scoreItems.push({
              name: `${label} (${strat})`,
              series,
              extra: {
                strategy: strat,
                // Google's own colour bands.
                verdict: latest >= 90 ? 'Good' : latest >= 50 ? 'Needs work' : 'Poor',
                checks_passed: newest.audits_total ? `${newest.audits_passed} of ${newest.audits_total}` : '-',
              },
            });
          }
        }
        if (scoreItems.length) {
          detail.pagespeed_scores = {
            id: 'pagespeed_scores',
            section: 'technical.speed_cwv',
            label: 'PageSpeed Scores - All Four Categories',
            itemLabel: 'Category', primaryLabel: 'Score',
            format: 'score', higherIsBetter: true,
            columns: [
              { key: 'verdict', label: 'Verdict', format: 'text' },
              { key: 'checks_passed', label: 'Checks passed', format: 'text' },
              { key: 'strategy', label: 'Device', format: 'text' },
            ],
            items: scoreItems,
          };
        }

        // The named fixes, with the saving each one is worth. This is the part
        // an owner can hand to a developer.
        const newest = new Map();
        for (const r of ps.recordset) newest.set(r.strategy, r);
        const oppItems = [];
        for (const [strat, r] of newest) {
          let opps = [];
          try { opps = JSON.parse(r.opportunities || '[]'); } catch { opps = []; }
          for (const o of opps) {
            const ms = Number(o.numeric_value ?? o.numericValue ?? 0);
            oppItems.push({
              name: `${o.title || o.id} (${strat})`,
              series: new Array(monthLabels.length).fill(null)
                .map((_, i) => (i === monthLabels.length - 1 ? Number(ms.toFixed(0)) : null)),
              extra: {
                strategy: strat,
                saving: o.display_value || o.displayValue || '-',
                // Lighthouse scores each audit 0-1; below 0.9 is why it is listed.
                audit_score: o.score == null ? '-' : Math.round(Number(o.score) * 100),
              },
            });
          }
        }
        if (oppItems.length) {
          detail.pagespeed_opportunities = {
            id: 'pagespeed_opportunities',
            section: 'technical.speed_cwv',
            label: 'Speed Fixes, Largest Saving First',
            itemLabel: 'Fix',
            primaryLabel: 'Est. saving (ms)',
            format: 'number',
            higherIsBetter: true,
            columns: [
              { key: 'saving', label: 'Estimated saving', format: 'text' },
              { key: 'strategy', label: 'Device', format: 'text' },
              { key: 'audit_score', label: 'Audit score', format: 'number' },
            ],
            items: oppItems.sort((a, b) =>
              (b.series.filter((v) => v != null).slice(-1)[0] || 0) -
              (a.series.filter((v) => v != null).slice(-1)[0] || 0)),
          };
        }
      }
    } catch (e) {
      console.warn('[arionMetrics] pagespeed reports skipped:', e.message);
    }

    // -- SE Ranking: competitors, backlinks, anchors (2026-08-14) -----------
    // 403k position rows and 1,049 backlink rows sat in these tables feeding
    // exactly two reports (keyword movement, referring domain counts). The
    // competitor column in position_history was never read at all, so "how do
    // we compare to the people we actually lose work to" — the question a
    // client asks first — had no answer anywhere in the product.
    try {
      const idxOfMonth4 = new Map(monthLabels.map((l, i) => [l, i]));

      // ── competitor rankings, keyword by keyword ────────────────────────
      const comp = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH monthly AS (
            SELECT competitor_domain, keyword,
                   ym = FORMAT(recorded_for, 'yyyy-MM'),
                   pos = AVG(CAST(position AS float))
              FROM arion.se_ranking_position_history
             WHERE site_id = @siteId
               AND competitor_domain IS NOT NULL AND competitor_domain <> ''
               AND position IS NOT NULL AND position > 0
               AND recorded_for >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
             GROUP BY competitor_domain, keyword, FORMAT(recorded_for, 'yyyy-MM')
          )
          SELECT competitor_domain, ym,
                 avg_pos = AVG(pos),
                 kw = COUNT(DISTINCT keyword),
                 top10 = SUM(CASE WHEN pos <= 10 THEN 1 ELSE 0 END),
                 top3  = SUM(CASE WHEN pos <= 3 THEN 1 ELSE 0 END)
            FROM monthly
           GROUP BY competitor_domain, ym
           ORDER BY competitor_domain, ym`);

      if (comp.recordset.length) {
        const byDomain = new Map();
        for (const r of comp.recordset) {
          if (!byDomain.has(r.competitor_domain)) byDomain.set(r.competitor_domain, { months: new Map(), latest: r });
          byDomain.get(r.competitor_domain).months.set(r.ym, r);
          byDomain.get(r.competitor_domain).latest = r;
        }
        const items = [...byDomain.entries()].map(([domain, rec]) => {
          const series = new Array(monthLabels.length).fill(null);
          for (const [ym, row] of rec.months) {
            const i = idxOfMonth4.get(ym);
            if (i != null) series[i] = Number(Number(row.avg_pos).toFixed(1));
          }
          return {
            name: domain,
            series,
            extra: {
              keywords: Number(rec.latest.kw || 0),
              top10: Number(rec.latest.top10 || 0),
              top3: Number(rec.latest.top3 || 0),
              // Ours or theirs — the whole point of the report is the compare.
              is_you: String(domain).replace(/^www\./, '') === String(site.domain).replace(/^www\./, '') ? 'You' : 'Competitor',
            },
          };
        });
        detail.competitor_rankings = {
          id: 'competitor_rankings',
          section: 'search_visibility.competitive_position',
          label: 'You vs Them - Average Position by Competitor',
          itemLabel: 'Domain', primaryLabel: 'Avg position',
          format: 'position', higherIsBetter: false,
          columns: [
            { key: 'is_you', label: 'Who', format: 'text' },
            { key: 'keywords', label: 'Keywords ranked', format: 'number' },
            { key: 'top10', label: 'On page one', format: 'number' },
            { key: 'top3', label: 'In the top 3', format: 'number' },
          ],
          items: items.sort((a, b) => Number(b.extra.top10) - Number(a.extra.top10)),
        };
      }

      // ── backlink quality ───────────────────────────────────────────────
      // A count of referring domains says nothing about whether they are worth
      // having. Authority, status and first-seen are all stored and unused.
      const bl = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH newest AS (
            SELECT *, rn = ROW_NUMBER() OVER (PARTITION BY referring_domain ORDER BY snapshot_date DESC)
              FROM arion.se_ranking_backlink_snapshot WHERE site_id = @siteId
          )
          SELECT referring_domain, target_url, anchor_text, domain_authority,
                 link_status, first_seen, last_seen, snapshot_date
            FROM newest WHERE rn = 1`);

      if (bl.recordset.length) {
        const last = monthLabels.length - 1;
        const items = bl.recordset.map((r) => {
          const series = new Array(monthLabels.length).fill(null);
          series[last] = Number(r.domain_authority || 0);
          const ageDays = r.first_seen ? Math.round((Date.now() - new Date(r.first_seen)) / 86400000) : null;
          return {
            name: r.referring_domain,
            series,
            extra: {
              authority: Number(r.domain_authority || 0),
              status: r.link_status || 'unknown',
              anchor: (r.anchor_text || '(none)').slice(0, 80),
              points_at: (r.target_url || '-').replace(/^https?:\/\/[^/]+/, '') || '/',
              age_days: ageDays == null ? 0 : ageDays,
            },
          };
        });
        detail.backlink_quality = {
          id: 'backlink_quality',
          section: 'search_visibility.domain_authority',
          label: 'Backlink Quality - Who Links to You and Is It Worth Anything',
          itemLabel: 'Linking domain', primaryLabel: 'Authority',
          format: 'number', higherIsBetter: true,
          columns: [
            { key: 'status', label: 'Status', format: 'text' },
            { key: 'anchor', label: 'Anchor text', format: 'text' },
            { key: 'points_at', label: 'Points at', format: 'text' },
            { key: 'age_days', label: 'Days known', format: 'number' },
          ],
          items: items.sort((a, b) => Number(b.extra.authority) - Number(a.extra.authority)),
        };

        // ── anchor text profile ──────────────────────────────────────────
        // Anchors are a ranking signal AND a spam signal. An unnatural profile
        // (the same commercial phrase over and over) is a penalty risk, and
        // nothing else in the product would show it.
        const byAnchor = new Map();
        for (const r of bl.recordset) {
          const a = (r.anchor_text || '(no anchor text)').trim().slice(0, 80) || '(no anchor text)';
          if (!byAnchor.has(a)) byAnchor.set(a, { n: 0, auth: 0 });
          const rec = byAnchor.get(a);
          rec.n++;
          rec.auth += Number(r.domain_authority || 0);
        }
        const total = bl.recordset.length;
        const anchorItems = [...byAnchor.entries()].map(([anchor, rec]) => {
          const series = new Array(monthLabels.length).fill(null);
          series[last] = rec.n;
          const brandish = new RegExp(String(site.domain).split('.')[0], 'i').test(anchor);
          return {
            name: anchor,
            series,
            extra: {
              links: rec.n,
              share: Number(((rec.n / total) * 100).toFixed(1)),
              avg_authority: Math.round(rec.auth / rec.n),
              kind: /^https?:|^www\./i.test(anchor) ? 'Bare URL'
                : brandish ? 'Branded'
                : anchor === '(no anchor text)' ? 'None'
                : 'Keyword',
            },
          };
        });
        detail.anchor_text_profile = {
          id: 'anchor_text_profile',
          section: 'search_visibility.domain_authority',
          label: 'Anchor Text - What Other Sites Call You',
          itemLabel: 'Anchor', primaryLabel: 'Links',
          format: 'number', higherIsBetter: true,
          columns: [
            { key: 'kind', label: 'Type', format: 'text' },
            { key: 'share', label: 'Share of links', format: 'percent' },
            { key: 'avg_authority', label: 'Avg authority', format: 'number' },
          ],
          items: anchorItems.sort((a, b) => Number(b.extra.links) - Number(a.extra.links)),
        };
      }
    } catch (e) {
      console.warn('[arionMetrics] se ranking reports skipped:', e.message);
    }

    // -- Hosting, domain and DNS health (migration 052, 2026-08-14) ---------
    // Brandon: "Hosting we don't have a single report, is that on purpose?"
    // It was not — the Hostinger integration exposes all of this and every call
    // was live-only, so nothing was stored and nothing could be reported.
    //
    // This is the checklist a consultant runs on day one and nobody runs again
    // until something breaks. Every row is a thing that takes a business
    // offline or sends its email to spam, and each carries the days remaining
    // rather than a date, because "expires in 9 days" is an instruction and a
    // date is a lookup.
    try {
      const hs = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`
          WITH ranked AS (
            SELECT h.*, ym = FORMAT(h.snapshot_date, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (PARTITION BY FORMAT(h.snapshot_date, 'yyyy-MM')
                                           ORDER BY h.snapshot_date DESC)
              FROM arion.site_hosting_snapshot h
             WHERE h.site_id = @siteId
               AND h.snapshot_date >= DATEADD(month, -12, CAST(GETUTCDATE() AS DATE))
          )
          SELECT * FROM ranked WHERE rn = 1 ORDER BY ym`);

      if (hs.recordset.length) {
        const idxOfMonth5 = new Map(monthLabels.map((l, i) => [l, i]));
        const newest = hs.recordset[hs.recordset.length - 1];
        const seriesFor = (col) => {
          const arr = new Array(monthLabels.length).fill(null);
          let any = false;
          for (const r of hs.recordset) {
            const i = idxOfMonth5.get(r.ym);
            if (i == null || r[col] == null) continue;
            arr[i] = Number(r[col]); any = true;
          }
          return any ? arr : null;
        };

        const items = [];
        const add = (name, series, extra) => { if (series) items.push({ name, series, extra }); };

        // Countdowns. Lower is worse, which is why this report is
        // higherIsBetter: false and the bands run shortest-first.
        add('SSL certificate', seriesFor('ssl_days_left'), {
          detail: newest.ssl_issuer || '-',
          expires: newest.ssl_expires_at ? String(newest.ssl_expires_at).slice(0, 10) : '-',
          verdict: newest.ssl_days_left == null ? '-'
            : newest.ssl_days_left <= 0 ? 'EXPIRED'
            : newest.ssl_days_left <= 14 ? 'Renew now'
            : newest.ssl_days_left <= 30 ? 'Renew soon' : 'Fine',
          what: 'A lapsed certificate takes the site off the internet and browsers show a security warning.',
        });
        add('Domain registration', seriesFor('domain_days_left'), {
          detail: newest.registrar || '-',
          expires: newest.domain_expires_at ? String(newest.domain_expires_at).slice(0, 10) : '-',
          verdict: newest.domain_days_left == null ? '-'
            : newest.domain_days_left <= 0 ? 'EXPIRED'
            : newest.domain_days_left <= 30 ? 'Renew now'
            : newest.domain_days_left <= 60 ? 'Renew soon' : 'Fine',
          what: newest.domain_auto_renew ? 'Auto-renew is on.' : 'Auto-renew is OFF — losing the domain loses the business.',
        });

        // Email deliverability: three DNS records that decide whether mail
        // lands. Modelled as 0/100 so they band alongside the countdowns.
        const flagSeries = (col) => {
          const arr = new Array(monthLabels.length).fill(null);
          let any = false;
          for (const r of hs.recordset) {
            const i = idxOfMonth5.get(r.ym);
            if (i == null || r[col] == null) continue;
            arr[i] = r[col] ? 100 : 0; any = true;
          }
          return any ? arr : null;
        };
        for (const [col, label, why] of [
          ['has_spf', 'SPF record', 'Without SPF, anyone can send email claiming to be your domain and your own mail is more likely to be filtered.'],
          ['has_dkim', 'DKIM record', 'DKIM signs your mail so receiving servers can prove it really came from you.'],
          ['has_dmarc', 'DMARC record', 'DMARC tells receiving servers what to do when a message fails the checks above. Missing it is why "our email goes to spam".'],
        ]) {
          add(label, flagSeries(col), {
            detail: newest[col] ? 'Present' : 'MISSING',
            expires: '-',
            verdict: newest[col] ? 'Fine' : 'Missing',
            what: why,
          });
        }

        if (items.length) {
          detail.hosting_health = {
            id: 'hosting_health',
            section: 'technical.hosting',
            label: 'Hosting, Domain and Email Records',
            itemLabel: 'Check',
            primaryLabel: 'Days remaining',
            format: 'number',
            higherIsBetter: true,
            columns: [
              { key: 'verdict', label: 'Status', format: 'text' },
              { key: 'expires', label: 'Expires', format: 'text' },
              { key: 'detail', label: 'Detail', format: 'text' },
              { key: 'what', label: 'Why it matters', format: 'text' },
            ],
            items,
          };
        }
      }
    } catch (e) {
      console.warn('[arionMetrics] hosting report skipped:', e.message);
    }

    // Site-level upkeep posture, from the newest snapshot row. These are
    // CURRENT-STATE values written into the last month slot: the snapshot table
    // only began carrying rows 2026-08-14, so there is no history to plot yet.
    // Every one of them accumulates a real 12-month series from here without
    // any further change — the nightly job now writes one row per site per day.
    try {
      const snap = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .query(`SELECT TOP 1 plugins_total, plugins_active, plugins_update_available,
                       core_update_available, theme_update_available,
                       core_health_critical, core_health_recommended,
                       rm_posts_missing_meta, rm_avg_seo_score, litespeed_opt_score
                  FROM arion.site_plugin_snapshot
                 WHERE site_id = @siteId ORDER BY snapshot_date DESC`);
      const s0 = snap.recordset[0];
      if (s0) {
        const put = (key, val) => {
          if (val == null) return;                    // absent ≠ zero — leave unmeasured
          const arr = metrics[key] || new Array(months).fill(null);
          arr[months - 1] = Number(val);
          metrics[key] = arr;
        };
        put('upkeep_updates_pending', s0.plugins_update_available);
        put('upkeep_components_total', s0.plugins_total);
        put('upkeep_health_critical', s0.core_health_critical);
        put('upkeep_health_recommended', s0.core_health_recommended);
        put('upkeep_meta_missing', s0.rm_posts_missing_meta);
        put('upkeep_seo_score', s0.rm_avg_seo_score);
        // Booleans → a 0/1 series so "core fell behind in March" is visible later.
        if (s0.core_update_available != null) put('upkeep_core_behind', s0.core_update_available ? 1 : 0);
        if (s0.theme_update_available != null) put('upkeep_theme_behind', s0.theme_update_available ? 1 : 0);
      }
    } catch (e) {
      console.warn('[arionMetrics] upkeep posture skipped:', e.message);
    }

    // ── Website Upkeep (2026-08-14) ────────────────────────────────────────
    // Brandon's Website question #1: "are you actually maintaining your website
    // properly." Line items are the site's own COMPONENTS — core, theme, every
    // plugin — because that is the level at which the answer is actionable.
    //
    // Source is arion.site_plugin_inventory (per-component) joined to today's
    // arion.site_plugin_snapshot (site-level posture). The snapshot table only
    // started carrying rows on 2026-08-14 when the auth bug was fixed, so this
    // is a `feed` report today — a full current-state list with columns — and
    // becomes a trend as days accumulate. Rendering an empty 12-month chart
    // instead would be the "not enough history" hole we already decided against.
    try {
      const inv = await pool.request()
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        // A 12-MONTH SERIES PER COMPONENT, not just today's row.
        //
        // First cut emitted a single point, so MoM, the trend sparkline and the
        // band distribution all rendered "—" — the deep engine had nothing to
        // move through. This takes each component's LAST capture in each of the
        // trailing 12 months and emits its status code for that month, so
        // "Elementor has been behind since March" is visible rather than implied.
        //
        // Keyed on plugin_file: plugin_slug is NULL on every row in prod
        // (104/104), so partitioning by it collapsed all components into one
        // NULL group and returned a single row.
        .query(`
          WITH ranked AS (
            SELECT i.plugin_file, i.plugin_name, i.current_version, i.new_version,
                   i.update_available, i.is_active, i.author, i.captured_at,
                   ym = FORMAT(i.captured_at, 'yyyy-MM'),
                   rn = ROW_NUMBER() OVER (
                          PARTITION BY i.plugin_file, FORMAT(i.captured_at, 'yyyy-MM')
                          ORDER BY i.captured_at DESC)
              FROM arion.site_plugin_inventory i
             WHERE i.site_id = @siteId
               AND i.captured_at >= DATEADD(month, -12, SYSDATETIMEOFFSET())
          )
          SELECT plugin_file, plugin_name, current_version, new_version,
                 update_available, is_active, author, ym
            FROM ranked
           WHERE rn = 1
           ORDER BY plugin_name, ym`);

      if (inv.recordset.length) {
        // month labels the rest of the payload already uses, so the sparkline
        // lines up with every other report on the page.
        const idxOfMonth = new Map(monthLabels.map((l, i) => [l, i]));
        const byComponent = new Map();
        for (const row of inv.recordset) {
          const key = row.plugin_file;
          if (!byComponent.has(key)) byComponent.set(key, { latest: row, months: new Map() });
          const rec = byComponent.get(key);
          rec.months.set(row.ym, row);
          rec.latest = row;                       // ORDER BY ym asc → last wins
        }

        const items = [...byComponent.values()].map(({ latest, months }) => {
          const series = new Array(monthLabels.length).fill(null);
          for (const [ym, row] of months) {
            const i = idxOfMonth.get(ym);
            if (i == null) continue;
            const needs = row.update_available === true || row.update_available === 1;
            const active = row.is_active === true || row.is_active === 1;
            series[i] = needs && !active ? 2 : needs ? 1 : 0;
          }
          const needsNow = latest.update_available === true || latest.update_available === 1;
          const activeNow = latest.is_active === true || latest.is_active === 1;
          // "Dormant risk" is the one an owner never thinks about: an INACTIVE
          // component still ships its code and still carries its vulnerabilities.
          const status = needsNow && !activeNow ? 'Dormant + outdated'
            : needsNow ? 'Update available'
            : !activeNow ? 'Inactive'
            : 'Current';
          // How long it has been behind — the number that turns a list into an
          // argument. Counts back from the newest month while the status is bad.
          let behindMonths = 0;
          for (let i = series.length - 1; i >= 0; i--) {
            if (series[i] == null) continue;
            if (series[i] > 0) behindMonths++; else break;
          }
          return {
            name: latest.plugin_name || latest.plugin_file || 'Unnamed component',
            series,
            extra: {
              status,
              installed: latest.current_version || '—',
              // new_version comes back NULL from the plugin even when an update
              // IS flagged, so we say "available" rather than invent a version.
              available: latest.new_version || (needsNow ? 'available' : '—'),
              state: activeNow ? 'Active' : 'Inactive',
              author: latest.author || '—',
              behind_months: behindMonths,
              needs_update: needsNow ? 1 : 0,
              is_active: activeNow ? 1 : 0,
            },
          };
        });

        detail.component_upkeep = {
          id: 'component_upkeep',
          section: 'technical.upkeep',
          label: 'Software Upkeep — Every Component On Your Site',
          itemLabel: 'Component',
          primaryLabel: 'Status',
          format: 'number',
          higherIsBetter: false,
          columns: [
            { key: 'status', label: 'Status', format: 'text' },
            { key: 'behind_months', label: 'Months behind', format: 'number' },
            { key: 'installed', label: 'Installed', format: 'text' },
            { key: 'state', label: 'Active', format: 'text' },
            { key: 'author', label: 'Author', format: 'text' },
          ],
          items: items.sort((a, b) =>
            (Number(b.extra.behind_months) - Number(a.extra.behind_months)) ||
            String(a.name).localeCompare(String(b.name))),
        };
      }
    } catch (e) {
      console.warn('[arionMetrics] component upkeep skipped:', e.message);
    }

    return { source: 'prod', months: monthLabels, metrics, detail, benchmarks };
  } catch (e) {
    return { source: 'prod', months: monthLabels, metrics: {}, error: e.message };
  }
}
