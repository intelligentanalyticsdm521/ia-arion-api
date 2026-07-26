/**
 * insightsSnapshot.js — pulls REAL monthly series from Google (GSC / GA4 /
 * GBP Performance) and MERGEs them into arion.metric_monthly, the storage
 * the whole IA Insights funnel reads (see INSIGHTS_MODEL_SPEC.md).
 *
 * Used by:
 *   - scripts/_backfill_google_prod.mts   — the one-time deep-history backfill
 *     (GSC ~16 months, GBP ~18 months, GA4 to retention)
 *   - POST /arion/internal/insights/snapshot — the monthly refresh the
 *     arion-func timer calls on the 1st (current + prior month)
 *
 * Metric keys written (must match lib/arionMetrics.js catalog keys — never
 * invent keys the catalog doesn't read):
 *   gsc:  gsc_impressions gsc_clicks gsc_ctr gsc_avg_position
 *         + dimension rows: gsc_query_clicks/impressions/position (query),
 *           gsc_page_clicks (page)
 *   ga4:  ga_sessions ga_users ga_new_users ga_engagement_rate ga_bounce_rate
 *         ga_avg_duration content_pageviews ga_conversions ga_conversion_rate
 *         ga_mobile_share
 *   gbp:  gbp_calls gbp_directions gbp_website_clicks gbp_impressions
 *         gbp_impr_search gbp_impr_maps gbp_action_rate
 *
 * All writes are MERGE-idempotent on (site, month, metric, dimension value).
 */
import sql from 'mssql';
import { getAccessToken } from './googleBusiness.js';
import { resolveGscProperty } from './googleServices.js';

const ym = (d) => d.toISOString().slice(0, 7);
const monthStart = (label) => `${label}-01`;

function monthLabelsBack(n) {
  const out = [];
  const now = new Date();
  for (let m = n - 1; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    out.push(ym(d));
  }
  return out;
}

async function gFetch(accessToken, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 200);
    const err = new Error(`${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── GSC ────────────────────────────────────────────────────────────────────
export async function pullGscMonthly(site, { months = 16, log = () => {} } = {}) {
  const ref = site.gsc_oauth_token_ref || site.gbp_oauth_token_ref;
  if (!ref) return { rows: [], reason: 'no token' };
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) return { rows: [], reason: 'refresh failed' };

  // Prefer the stored property, but fall back to whatever property this
  // token can actually see (Briarwood's stored www-variant 403s while the
  // token holds a different variant).
  let prop = site.gsc_site_url || null;
  const labels = monthLabelsBack(months);
  const start = monthStart(labels[0]);
  const end = new Date().toISOString().slice(0, 10);
  const q = (property, body) =>
    gFetch(tok.access_token, 'POST', `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, body);

  let daily;
  for (const candidate of [prop, null]) {
    const property = candidate || await resolveGscProperty(tok.access_token, site.domain);
    try {
      daily = await q(property, { startDate: start, endDate: end, dimensions: ['date'], rowLimit: 5000 });
      prop = property;
      break;
    } catch (e) {
      if (e.status !== 403 || candidate === null) {
        if (candidate === null) return { rows: [], reason: `gsc ${e.message.slice(0, 120)}` };
      }
    }
  }
  if (!daily) return { rows: [], reason: 'gsc no accessible property' };
  log(`gsc property ${prop} · ${daily.rows?.length ?? 0} day rows`);

  // monthly totals, impression-weighted position
  const agg = new Map(); // ym -> {clicks, impr, posW}
  for (const r of daily.rows || []) {
    const m = String(r.keys[0]).slice(0, 7);
    if (!agg.has(m)) agg.set(m, { clicks: 0, impr: 0, posW: 0 });
    const a = agg.get(m);
    a.clicks += r.clicks || 0;
    a.impr += r.impressions || 0;
    a.posW += (r.position || 0) * (r.impressions || 0);
  }
  const rows = [];
  for (const [m, a] of agg) {
    rows.push({ ym: m, source: 'gsc', key: 'gsc_impressions', value: a.impr });
    rows.push({ ym: m, source: 'gsc', key: 'gsc_clicks', value: a.clicks });
    if (a.impr > 0) {
      rows.push({ ym: m, source: 'gsc', key: 'gsc_ctr', value: Number(((a.clicks / a.impr) * 100).toFixed(2)) });
      rows.push({ ym: m, source: 'gsc', key: 'gsc_avg_position', value: Number((a.posW / a.impr).toFixed(2)) });
    }
  }

  // per-month query + page dimension rows (detail layer)
  for (const m of labels) {
    if (!agg.has(m)) continue; // no traffic data that month
    const mStart = monthStart(m);
    const mEnd = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    try {
      const qr = await q(prop, { startDate: mStart, endDate: mEnd, dimensions: ['query'], rowLimit: 50 });
      for (const r of qr.rows || []) {
        const dv = String(r.keys[0]).slice(0, 200);
        rows.push({ ym: m, source: 'gsc', key: 'gsc_query_clicks', dim: 'query', dimv: dv, value: r.clicks || 0 });
        rows.push({ ym: m, source: 'gsc', key: 'gsc_query_impressions', dim: 'query', dimv: dv, value: r.impressions || 0 });
        rows.push({ ym: m, source: 'gsc', key: 'gsc_query_position', dim: 'query', dimv: dv, value: Number((r.position || 0).toFixed(2)) });
      }
      const pr = await q(prop, { startDate: mStart, endDate: mEnd, dimensions: ['page'], rowLimit: 30 });
      for (const r of pr.rows || []) {
        rows.push({ ym: m, source: 'gsc', key: 'gsc_page_clicks', dim: 'page', dimv: String(r.keys[0]).slice(0, 200), value: r.clicks || 0 });
      }
    } catch (e) {
      log(`gsc ${m} dims skipped: ${e.message.slice(0, 100)}`);
    }
  }
  return { rows, property: prop };
}

// GA4 events that count as CONVERSIONS for a local business. Zero key events
// are configured on ANY of the four prod properties (probed 2026-07-25), but
// the conversion-shaped events fire anyway — tel taps, form submits, email
// taps. Derive ga_conversions from these instead of GA4's keyEvents config.
const GA4_CONVERSION_EVENTS = new Set([
  'tel', 'mailto', 'form_submit', 'generate_lead', 'submit_form',
  'phone_call', 'click_to_call', 'book_appointment', 'purchase',
]);

// ── GA4 ────────────────────────────────────────────────────────────────────
export async function pullGa4Monthly(site, { months = 16, log = () => {} } = {}) {
  const ref = site.gsc_oauth_token_ref || site.gbp_oauth_token_ref;
  const propertyId = site.ga4_property_id;
  if (!ref || !propertyId) return { rows: [], reason: 'no token or property' };
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) return { rows: [], reason: 'refresh failed' };

  const labels = monthLabelsBack(months);
  const range = { startDate: monthStart(labels[0]), endDate: 'today' };
  const run = (body) => gFetch(tok.access_token, 'POST',
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, body);

  const metricSets = [
    ['sessions', 'totalUsers', 'newUsers', 'engagementRate', 'averageSessionDuration', 'screenPageViews', 'keyEvents'],
    ['sessions', 'totalUsers', 'newUsers', 'engagementRate', 'averageSessionDuration', 'screenPageViews'], // older properties: no keyEvents
  ];
  let rep = null, usedMetrics = null;
  for (const set of metricSets) {
    try {
      rep = await run({ dateRanges: [range], dimensions: [{ name: 'yearMonth' }], metrics: set.map((m) => ({ name: m })), limit: 100 });
      usedMetrics = set;
      break;
    } catch (e) {
      log(`ga4 metric set failed (${e.message.slice(0, 90)}) — retrying reduced set`);
    }
  }
  if (!rep) return { rows: [], reason: 'ga4 runReport failed' };

  const rows = [];
  const sessionsByMonth = new Map();
  for (const r of rep.rows || []) {
    const label = String(r.dimensionValues[0].value); // YYYYMM
    const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
    const v = (name) => {
      const i = usedMetrics.indexOf(name);
      return i >= 0 ? Number(r.metricValues[i].value) : null;
    };
    const sessions = v('sessions');
    sessionsByMonth.set(m, sessions || 0);
    rows.push({ ym: m, source: 'ga4', key: 'ga_sessions', value: sessions });
    rows.push({ ym: m, source: 'ga4', key: 'ga_users', value: v('totalUsers') });
    rows.push({ ym: m, source: 'ga4', key: 'ga_new_users', value: v('newUsers') });
    const er = v('engagementRate');
    if (er != null) {
      rows.push({ ym: m, source: 'ga4', key: 'ga_engagement_rate', value: Number((er * 100).toFixed(1)) });
      rows.push({ ym: m, source: 'ga4', key: 'ga_bounce_rate', value: Number((100 - er * 100).toFixed(1)) });
    }
    const dur = v('averageSessionDuration');
    if (dur != null) rows.push({ ym: m, source: 'ga4', key: 'ga_avg_duration', value: Math.round(dur) });
    const pv = v('screenPageViews');
    if (pv != null) rows.push({ ym: m, source: 'ga4', key: 'content_pageviews', value: pv });
  }

  // Conversions from conversion-shaped EVENTS (tel/form_submit/mailto/…) —
  // real user actions, independent of GA4 key-event configuration.
  try {
    const ev = await run({
      dateRanges: [range],
      dimensions: [{ name: 'yearMonth' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      limit: 5000,
    });
    const convByMonth = new Map();
    for (const r of ev.rows || []) {
      const label = String(r.dimensionValues[0].value);
      const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
      const name = String(r.dimensionValues[1].value).toLowerCase();
      if (!GA4_CONVERSION_EVENTS.has(name)) continue;
      convByMonth.set(m, (convByMonth.get(m) || 0) + Number(r.metricValues[0].value));
    }
    // Months with sessions but no conversion events are REAL zeros.
    if (convByMonth.size) {
      for (const [m, sessions] of sessionsByMonth) {
        const conv = convByMonth.get(m) || 0;
        rows.push({ ym: m, source: 'ga4', key: 'ga_conversions', value: conv });
        if (sessions > 0) rows.push({ ym: m, source: 'ga4', key: 'ga_conversion_rate', value: Number(((conv / sessions) * 100).toFixed(2)) });
      }
    }
  } catch (e) {
    log(`ga4 conversion events skipped: ${e.message.slice(0, 90)}`);
  }

  // device split → ga_mobile_share
  try {
    const dev = await run({
      dateRanges: [range],
      dimensions: [{ name: 'yearMonth' }, { name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }],
      limit: 500,
    });
    const byM = new Map();
    for (const r of dev.rows || []) {
      const label = String(r.dimensionValues[0].value);
      const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
      const cat = String(r.dimensionValues[1].value).toLowerCase();
      const s = Number(r.metricValues[0].value);
      if (!byM.has(m)) byM.set(m, { mobile: 0, total: 0 });
      byM.get(m).total += s;
      if (cat === 'mobile' || cat === 'tablet') byM.get(m).mobile += s;
    }
    for (const [m, a] of byM) {
      if (a.total > 0) rows.push({ ym: m, source: 'ga4', key: 'ga_mobile_share', value: Number(((a.mobile / a.total) * 100).toFixed(1)) });
    }
  } catch (e) {
    log(`ga4 device split skipped: ${e.message.slice(0, 90)}`);
  }
  return { rows };
}

// ── GBP Performance ────────────────────────────────────────────────────────
const GBP_METRICS = [
  'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
];

export async function pullGbpMonthly(site, { months = 18, log = () => {} } = {}) {
  const ref = site.gbp_oauth_token_ref;
  // Stored as 'accounts/{acct}/locations/{id}' — the Performance API path
  // wants ONLY the 'locations/{id}' tail (the full form 404s, verified
  // 2026-07-25).
  const location = site.gbp_location_name?.match(/locations\/[^/]+$/)?.[0] || null;
  if (!ref || !location) return { rows: [], reason: 'no token or location' };
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) return { rows: [], reason: 'refresh failed' };

  const now = new Date();
  const startD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const params = new URLSearchParams();
  for (const m of GBP_METRICS) params.append('dailyMetrics', m);
  params.append('dailyRange.start_date.year', String(startD.getUTCFullYear()));
  params.append('dailyRange.start_date.month', String(startD.getUTCMonth() + 1));
  params.append('dailyRange.start_date.day', '1');
  params.append('dailyRange.end_date.year', String(now.getUTCFullYear()));
  params.append('dailyRange.end_date.month', String(now.getUTCMonth() + 1));
  params.append('dailyRange.end_date.day', String(now.getUTCDate()));

  let data;
  try {
    data = await gFetch(tok.access_token, 'GET',
      `https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries?${params}`);
  } catch (e) {
    return { rows: [], reason: `gbp ${e.message.slice(0, 120)}` };
  }

  // shape: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric, timeSeries: { datedValues: [{date:{y,m,d}, value}] } }] }] }
  const perMonth = new Map(); // ym -> { metric: sum }
  const seriesList = (data.multiDailyMetricTimeSeries || []).flatMap((b) => b.dailyMetricTimeSeries || []);
  for (const s of seriesList) {
    const metric = s.dailyMetric;
    for (const dv of s.timeSeries?.datedValues || []) {
      const d = dv.date;
      if (!d?.year) continue;
      const m = `${d.year}-${String(d.month).padStart(2, '0')}`;
      const val = Number(dv.value || 0);
      if (!perMonth.has(m)) perMonth.set(m, {});
      perMonth.get(m)[metric] = (perMonth.get(m)[metric] || 0) + val;
    }
  }

  const rows = [];
  for (const [m, a] of perMonth) {
    const calls = a.CALL_CLICKS || 0;
    const dirs = a.BUSINESS_DIRECTION_REQUESTS || 0;
    const web = a.WEBSITE_CLICKS || 0;
    const imprSearch = (a.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) + (a.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0);
    const imprMaps = (a.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) + (a.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0);
    const impr = imprSearch + imprMaps;
    rows.push({ ym: m, source: 'gbp', key: 'gbp_calls', value: calls });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_directions', value: dirs });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_website_clicks', value: web });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impressions', value: impr });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_search', value: imprSearch });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_maps', value: imprMaps });
    if (impr > 0) rows.push({ ym: m, source: 'gbp', key: 'gbp_action_rate', value: Number((((calls + dirs + web) / impr) * 100).toFixed(2)) });
  }
  log(`gbp ${location}: ${perMonth.size} months`);
  return { rows };
}

// ── MERGE into arion.metric_monthly ────────────────────────────────────────
export async function mergeMetricRows(pool, site, rows) {
  let upserted = 0;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).filter((r) => r.value != null && isFinite(r.value));
    if (!chunk.length) continue;
    const req = pool.request();
    req.input('tid', sql.UniqueIdentifier, site.tenant_id);
    req.input('sid', sql.UniqueIdentifier, site.site_id);
    const values = chunk.map((r, j) => {
      req.input(`m${j}`, sql.Date, monthStart(r.ym));
      req.input(`s${j}`, sql.NVarChar(30), r.source);
      req.input(`k${j}`, sql.NVarChar(60), r.key);
      req.input(`d${j}`, sql.NVarChar(40), r.dim ?? null);
      req.input(`v${j}`, sql.NVarChar(200), r.dimv ?? null);
      req.input(`x${j}`, sql.Decimal(18, 4), r.value);
      return `(@m${j}, @s${j}, @k${j}, @d${j}, @v${j}, @x${j})`;
    }).join(',');
    const res = await req.query(`
      MERGE arion.metric_monthly AS tgt
      USING (SELECT @tid tenant_id, @sid site_id, v.pm, v.src, v.mk, v.dim, v.dimv, v.val
             FROM (VALUES ${values}) v(pm, src, mk, dim, dimv, val)) AS src
        ON tgt.site_id = src.site_id AND tgt.period_month = src.pm AND tgt.metric_key = src.mk
           AND ISNULL(tgt.dimension,'~') = ISNULL(src.dim,'~') AND ISNULL(tgt.dimension_value,'~') = ISNULL(src.dimv,'~')
      WHEN MATCHED THEN UPDATE SET value = src.val, captured_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, site_id, period_month, source, metric_key, dimension, dimension_value, value)
        VALUES (src.tenant_id, src.site_id, src.pm, src.src, src.mk, src.dim, src.dimv, src.val);`);
    upserted += res.rowsAffected.reduce((a, b) => a + b, 0);
  }
  return upserted;
}

// ── SE Ranking monthly aggregation ─────────────────────────────────────────
// Aggregates own-site position history (captured daily by the arion-func
// Market Monitor moves job, backfilled 2026-07-25) into kw_* monthly rows on
// the canonical engine (the site's engine with the most rows — Google
// desktop for every current project).
export async function aggregateSeRankingMonthly(pool, site) {
  const pe = await pool.request()
    .input('sid', sql.UniqueIdentifier, site.site_id)
    .query(`
      SELECT TOP 1 site_engine_id FROM arion.se_ranking_position_history
      WHERE site_id=@sid AND competitor_domain IS NULL
      GROUP BY site_engine_id ORDER BY COUNT(*) DESC`);
  const engineId = pe.recordset[0]?.site_engine_id;
  if (!engineId) return 0;
  const res = await pool.request()
    .input('tid', sql.UniqueIdentifier, site.tenant_id)
    .input('sid', sql.UniqueIdentifier, site.site_id)
    .input('eng', sql.NVarChar(40), engineId)
    .query(`
      WITH kwMonth AS (
        SELECT DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1) pm,
               keyword_id, MAX(keyword) kw,
               AVG(CAST(position AS float)) avg_pos
        FROM arion.se_ranking_position_history
        WHERE site_id=@sid AND site_engine_id=@eng AND competitor_domain IS NULL
          AND recorded_for >= DATEADD(month, -13, GETUTCDATE())
        GROUP BY DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1), keyword_id
      ), agg AS (
        SELECT pm, 'kw_tracked' mk, CAST(NULL AS nvarchar(40)) dim, CAST(NULL AS nvarchar(200)) dimv, CAST(COUNT(*) AS decimal(18,4)) v FROM kwMonth GROUP BY pm
        UNION ALL SELECT pm, 'kw_top3',  NULL, NULL, SUM(CASE WHEN avg_pos <= 3  THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
        UNION ALL SELECT pm, 'kw_top10', NULL, NULL, SUM(CASE WHEN avg_pos <= 10 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
        UNION ALL SELECT pm, 'kw_top30', NULL, NULL, SUM(CASE WHEN avg_pos <= 30 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
        UNION ALL SELECT pm, 'kw_position', 'keyword', LEFT(kw, 200), CAST(avg_pos AS decimal(18,4)) FROM kwMonth WHERE avg_pos IS NOT NULL
      )
      MERGE arion.metric_monthly AS tgt
      USING (SELECT @tid tenant_id, @sid site_id, pm, 'seranking' src, mk, dim, dimv, v FROM agg) AS src
        ON tgt.site_id = src.site_id AND tgt.period_month = src.pm AND tgt.metric_key = src.mk
           AND ISNULL(tgt.dimension,'~') = ISNULL(src.dim,'~') AND ISNULL(tgt.dimension_value,'~') = ISNULL(src.dimv,'~')
      WHEN MATCHED THEN UPDATE SET value = src.v, captured_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, site_id, period_month, source, metric_key, dimension, dimension_value, value)
        VALUES (src.tenant_id, src.site_id, src.pm, src.src, src.mk, src.dim, src.dimv, src.v);`);
  return res.rowsAffected.reduce((a, b) => a + b, 0);
}

/**
 * The monthly refresh — every site, every source, RECENT months only
 * (the deep backfill was a one-time script; this keeps it current).
 * Called by POST /internal/insights-snapshot-tick from the arion-func timer.
 */
export async function runFullInsightsSnapshot(pool, log = () => {}) {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain, gbp_oauth_token_ref, gsc_oauth_token_ref,
           gsc_site_url, ga4_property_id, gbp_location_name
    FROM arion.site WHERE domain IS NOT NULL`)).recordset;

  const summary = { sites: sites.length, seranking: 0, results: {} };
  for (const site of sites) {
    try {
      summary.seranking += await aggregateSeRankingMonthly(pool, site);
      summary.results[site.domain] = await snapshotGoogleSources(pool, site, {
        gscMonths: 2, ga4Months: 2, gbpMonths: 2, log: (m) => log(`${site.domain}: ${m}`),
      });
    } catch (e) {
      summary.results[site.domain] = { error: e.message.slice(0, 150) };
      log(`${site.domain} ERROR: ${e.message}`);
    }
  }
  return summary;
}

/** One site, all Google sources. Returns per-source row counts + reasons. */
export async function snapshotGoogleSources(pool, site, opts = {}) {
  const log = opts.log || (() => {});
  const out = {};
  for (const [name, fn, o] of [
    ['gsc', pullGscMonthly, { months: opts.gscMonths ?? 16, log }],
    ['ga4', pullGa4Monthly, { months: opts.ga4Months ?? 14, log }],
    ['gbp', pullGbpMonthly, { months: opts.gbpMonths ?? 18, log }],
  ]) {
    try {
      const r = await fn(site, o);
      out[name] = { pulled: r.rows.length, reason: r.reason || null };
      if (r.rows.length) out[name].upserted = await mergeMetricRows(pool, site, r.rows);
    } catch (e) {
      out[name] = { pulled: 0, reason: e.message.slice(0, 150) };
    }
  }
  return out;
}
