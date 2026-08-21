/**
 * insightsSnapshot.js â€” pulls REAL monthly series from Google (GSC / GA4 /
 * GBP Performance) and MERGEs them into arion.metric_monthly, the storage
 * the whole IA Insights funnel reads (see INSIGHTS_MODEL_SPEC.md).
 *
 * Used by:
 *   - scripts/_backfill_google_prod.mts   â€” the one-time deep-history backfill
 *     (GSC ~16 months, GBP ~18 months, GA4 to retention)
 *   - POST /arion/internal/insights/snapshot â€” the monthly refresh the
 *     arion-func timer calls on the 1st (current + prior month)
 *
 * Metric keys written (must match lib/arionMetrics.js catalog keys â€” never
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

// â”€â”€ GSC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  log(`gsc property ${prop} Â· ${daily.rows?.length ?? 0} day rows`);

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

  // per-month dimension rows (detail layer): queries, pages, devices
  for (const m of labels) {
    if (!agg.has(m)) continue; // no traffic data that month
    const mStart = monthStart(m);
    const mEnd = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    // Search Console allows 25,000 rows per request and six dimensions. We were
    // asking for 50 queries and 30 pages and ignoring country and search
    // appearance entirely — so the long tail, every geographic question, and
    // every "are we winning rich results" question were all invisible.
    // Brandon 2026-08-14: capture every data point available.
    //
    // Each block is independently caught: one dimension that a property does
    // not support must not cost us the other five.
    const dimPulls = [
      // dimension(s)      row cap   metric key prefix   how the value is labelled
      { dims: ['query'],   limit: 1000, prefix: 'gsc_query',    dim: 'query' },
      { dims: ['page'],    limit: 500,  prefix: 'gsc_page',     dim: 'page' },
      { dims: ['device'],  limit: 10,   prefix: 'gsc_device',   dim: 'device', lower: true },
      { dims: ['country'], limit: 100,  prefix: 'gsc_country',  dim: 'country', lower: true },
      // Rich results, FAQ, video, "How to" — which of Google's presentation
      // formats a site actually earns. Not every property reports it.
      { dims: ['searchAppearance'], limit: 50, prefix: 'gsc_appearance', dim: 'search_appearance' },
    ];

    for (const p of dimPulls) {
      try {
        const res = await q(prop, { startDate: mStart, endDate: mEnd, dimensions: p.dims, rowLimit: p.limit });
        for (const r of res.rows || []) {
          let dv = String(r.keys[0]).slice(0, 200);
          if (p.lower) dv = dv.toLowerCase();
          rows.push({ ym: m, source: 'gsc', key: `${p.prefix}_clicks`, dim: p.dim, dimv: dv, value: r.clicks || 0 });
          rows.push({ ym: m, source: 'gsc', key: `${p.prefix}_impressions`, dim: p.dim, dimv: dv, value: r.impressions || 0 });
          // Position is meaningless for a device or country split of the same
          // pages, but it is the whole point for a query or a page.
          if (p.dim === 'query' || p.dim === 'page') {
            rows.push({ ym: m, source: 'gsc', key: `${p.prefix}_position`, dim: p.dim, dimv: dv, value: Number((r.position || 0).toFixed(2)) });
          }
        }
      } catch (e) {
        log(`gsc ${m} ${p.dims.join('+')} skipped: ${e.message.slice(0, 90)}`);
      }
    }

    // page × query pairs — the only way to answer "which search brings someone
    // to THIS page", which is the question behind every content decision.
    try {
      const pq = await q(prop, { startDate: mStart, endDate: mEnd, dimensions: ['page', 'query'], rowLimit: 1000 });
      for (const r of pq.rows || []) {
        const dv = `${String(r.keys[0]).slice(0, 120)} :: ${String(r.keys[1]).slice(0, 80)}`;
        rows.push({ ym: m, source: 'gsc', key: 'gsc_pagequery_clicks', dim: 'page_query', dimv: dv, value: r.clicks || 0 });
        rows.push({ ym: m, source: 'gsc', key: 'gsc_pagequery_impressions', dim: 'page_query', dimv: dv, value: r.impressions || 0 });
        rows.push({ ym: m, source: 'gsc', key: 'gsc_pagequery_position', dim: 'page_query', dimv: dv, value: Number((r.position || 0).toFixed(2)) });
      }
    } catch (e) {
      log(`gsc ${m} page+query skipped: ${e.message.slice(0, 90)}`);
    }
  }
  return { rows, property: prop };
}

// GA4 events that count as CONVERSIONS for a local business. Zero key events
// are configured on ANY of the four prod properties (probed 2026-07-25), but
// the conversion-shaped events fire anyway â€” tel taps, form submits, email
// taps. Derive ga_conversions from these instead of GA4's keyEvents config.
const GA4_CONVERSION_EVENTS = new Set([
  'tel', 'mailto', 'form_submit', 'generate_lead', 'submit_form',
  'phone_call', 'click_to_call', 'book_appointment', 'purchase',
]);

// â”€â”€ GA4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      log(`ga4 metric set failed (${e.message.slice(0, 90)}) â€” retrying reduced set`);
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

  // Conversions from conversion-shaped EVENTS (tel/form_submit/mailto/â€¦) â€”
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

  // device split â†’ ga_mobile_share + device dimension rows
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
      rows.push({ ym: m, source: 'ga4', key: 'ga_device_sessions', dim: 'device', dimv: cat, value: s });
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

  // â”€â”€ Ingestion Phase 2 dims (2026-07-26): channels, sources, landing pages,
  // cities â€” the line items behind Channel Breakdown / Referral Sources /
  // Geography / Engagement-by-* detail reports. One full-range request per
  // dimension; top-N per month client-side to bound row volume.
  const dimPull = async (gaDim, topN, emit) => {
    try {
      const rep2 = await run({
        dateRanges: [range],
        dimensions: [{ name: 'yearMonth' }, { name: gaDim }],
        metrics: [{ name: 'sessions' }, { name: 'engagementRate' }],
        limit: 10000,
      });
      const byMonth = new Map();
      for (const r of rep2.rows || []) {
        const label = String(r.dimensionValues[0].value);
        const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
        const dv = String(r.dimensionValues[1].value || '(unknown)').slice(0, 200);
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push({ dv, sessions: Number(r.metricValues[0].value), er: Number(r.metricValues[1].value) });
      }
      for (const [m, list] of byMonth) {
        list.sort((a, b) => b.sessions - a.sessions);
        for (const it of list.slice(0, topN)) emit(m, it);
      }
    } catch (e) {
      log(`ga4 ${gaDim} dims skipped: ${e.message.slice(0, 90)}`);
    }
  };
  await dimPull('sessionDefaultChannelGroup', 25, (m, it) => {
    rows.push({ ym: m, source: 'ga4', key: 'ga_channel_sessions', dim: 'channel', dimv: it.dv, value: it.sessions });
    rows.push({ ym: m, source: 'ga4', key: 'ga_channel_engagement', dim: 'channel', dimv: it.dv, value: Number((it.er * 100).toFixed(1)) });
  });
  await dimPull('sessionSource', 100, (m, it) => {
    rows.push({ ym: m, source: 'ga4', key: 'ga_source_sessions', dim: 'source', dimv: it.dv, value: it.sessions });
  });
  await dimPull('landingPage', 100, (m, it) => {
    rows.push({ ym: m, source: 'ga4', key: 'ga_page_sessions', dim: 'page', dimv: it.dv, value: it.sessions });
    rows.push({ ym: m, source: 'ga4', key: 'ga_page_engagement', dim: 'page', dimv: it.dv, value: Number((it.er * 100).toFixed(1)) });
  });
  await dimPull('city', 50, (m, it) => {
    rows.push({ ym: m, source: 'ga4', key: 'ga_city_sessions', dim: 'city', dimv: it.dv, value: it.sessions });
  });

  // ── Ingestion Phase 3 (2026-08-14) — Brandon: capture every data point
  // available. Sessions and engagement rate answer "how many came and did they
  // stay". They cannot answer the questions an owner actually asks: is this
  // traffic NEW or the same people back again, does the phone browser behave
  // differently from the desktop one, which campaign paid for itself, what
  // hour do people actually look. Each dimension below is one of those.
  //
  // A richer pull: same shape as dimPull but carries users / new users /
  // bounce rate / duration / conversions rather than two columns.
  const RICH_METRICS = ['sessions', 'totalUsers', 'newUsers', 'bounceRate',
                        'averageSessionDuration', 'screenPageViews'];
  const dimPullRich = async (gaDim, topN, dimName, keyPrefix) => {
    try {
      const rep3 = await run({
        dateRanges: [range],
        dimensions: [{ name: 'yearMonth' }, { name: gaDim }],
        metrics: RICH_METRICS.map((n) => ({ name: n })),
        limit: 20000,
      });
      const byMonth = new Map();
      for (const r of rep3.rows || []) {
        const label = String(r.dimensionValues[0].value);
        const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
        const dv = String(r.dimensionValues[1].value || '(unknown)').slice(0, 200);
        const v = RICH_METRICS.map((_, i) => Number(r.metricValues[i]?.value || 0));
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push({ dv, v });
      }
      for (const [m, list] of byMonth) {
        list.sort((a, b) => b.v[0] - a.v[0]);
        for (const it of list.slice(0, topN)) {
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_sessions`, dim: dimName, dimv: it.dv, value: it.v[0] });
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_users`, dim: dimName, dimv: it.dv, value: it.v[1] });
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_new_users`, dim: dimName, dimv: it.dv, value: it.v[2] });
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_bounce_rate`, dim: dimName, dimv: it.dv, value: Number((it.v[3] * 100).toFixed(1)) });
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_avg_duration`, dim: dimName, dimv: it.dv, value: Number(it.v[4].toFixed(1)) });
          rows.push({ ym: m, source: 'ga4', key: `${keyPrefix}_pageviews`, dim: dimName, dimv: it.dv, value: it.v[5] });
        }
      }
    } catch (e) {
      log(`ga4 ${gaDim} rich dims skipped: ${e.message.slice(0, 90)}`);
    }
  };

  await dimPullRich('country', 50, 'country', 'ga_country');
  await dimPullRich('browser', 15, 'browser', 'ga_browser');
  await dimPullRich('newVsReturning', 4, 'visitor_type', 'ga_visitor');
  await dimPullRich('sessionMedium', 30, 'medium', 'ga_medium');
  await dimPullRich('sessionCampaignName', 30, 'campaign', 'ga_campaign');
  await dimPullRich('pageTitle', 60, 'page_title', 'ga_title');
  await dimPullRich('operatingSystem', 12, 'os', 'ga_os');
  // Hour of day: 24 values, and the answer to "when should we be answering the
  // phone" / "when should SPARK send". Kept whole rather than top-N.
  await dimPullRich('hour', 24, 'hour', 'ga_hour');

  // conversions by source â€” which channel actually produces the tel/form/
  // mailto actions (feeds the Conversions by Source detail report)
  try {
    const cv = await run({
      dateRanges: [range],
      dimensions: [{ name: 'yearMonth' }, { name: 'sessionSource' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...GA4_CONVERSION_EVENTS] } } },
      limit: 10000,
    });
    const byMonthSrc = new Map(); // ym -> Map(source -> count)
    for (const r of cv.rows || []) {
      const label = String(r.dimensionValues[0].value);
      const m = `${label.slice(0, 4)}-${label.slice(4, 6)}`;
      const src2 = String(r.dimensionValues[1].value || '(direct)').slice(0, 200);
      if (!byMonthSrc.has(m)) byMonthSrc.set(m, new Map());
      const inner = byMonthSrc.get(m);
      inner.set(src2, (inner.get(src2) || 0) + Number(r.metricValues[0].value));
    }
    for (const [m, inner] of byMonthSrc) {
      for (const [src2, v] of inner) {
        rows.push({ ym: m, source: 'ga4', key: 'ga_conv_by_source', dim: 'source', dimv: src2, value: v });
      }
    }
  } catch (e) {
    log(`ga4 conv-by-source skipped: ${e.message.slice(0, 90)}`);
  }

  return { rows };
}

// â”€â”€ GBP review history (Ingestion Phase 2b, 2026-07-26) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Full review list via the v4 API (needs the FULL accounts/.../locations/...
// name â€” this one, unlike the Performance API, rejects the bare tail).
// Derives real monthly series: velocity (new/mo), cumulative count,
// cumulative average rating, cumulative response rate.
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export async function pullGbpReviews(site, { log = () => {} } = {}) {
  const ref = site.gbp_oauth_token_ref;
  const location = site.gbp_location_name; // full 'accounts/.../locations/...'
  if (!ref || !location || !/^accounts\//.test(location)) return { rows: [], reason: 'no token or full location name' };
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) return { rows: [], reason: 'refresh failed' };

  const reviews = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ pageSize: '50' });
    if (pageToken) params.set('pageToken', pageToken);
    let data;
    try {
      data = await gFetch(tok.access_token, 'GET', `https://mybusiness.googleapis.com/v4/${location}/reviews?${params}`);
    } catch (e) {
      if (page === 0) return { rows: [], reason: `gbp reviews ${e.message.slice(0, 100)}` };
      break;
    }
    for (const r of data.reviews || []) {
      reviews.push({
        when: r.createTime ? String(r.createTime).slice(0, 7) : null,
        stars: STARS[r.starRating] || null,
        replied: !!r.reviewReply,
      });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  if (!reviews.length) return { rows: [], reason: 'no reviews' };
  log(`gbp reviews: ${reviews.length} total`);

  // chronological cumulative series by month
  reviews.sort((a, b) => (a.when || '').localeCompare(b.when || ''));
  const months = [...new Set(reviews.map((r) => r.when).filter(Boolean))];
  const rows = [];
  let count = 0, starSum = 0, starN = 0, repliedN = 0;
  let i = 0;
  for (const m of months) {
    let newThisMonth = 0;
    while (i < reviews.length && reviews[i].when === m) {
      const r = reviews[i++];
      count++; newThisMonth++;
      if (r.stars != null) { starSum += r.stars; starN++; }
      if (r.replied) repliedN++;
    }
    rows.push({ ym: m, source: 'gbp', key: 'gbp_review_count', value: count });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_review_velocity', value: newThisMonth });
    if (starN) rows.push({ ym: m, source: 'gbp', key: 'gbp_rating', value: Number((starSum / starN).toFixed(2)) });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_response_rate', value: Number(((repliedN / count) * 100).toFixed(1)) });
  }
  return { rows };
}

// â”€â”€ GBP Performance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Every DAILY_METRIC the Business Profile Performance API exposes. The four
// added 2026-08-14 were simply never asked for:
//   BUSINESS_CONVERSATIONS  — messages sent through the listing. For a service
//                             business this is a lead, and it was invisible.
//   BUSINESS_BOOKINGS       — appointments booked from the listing.
//   BUSINESS_FOOD_ORDERS / BUSINESS_FOOD_MENU_CLICKS — return 0 for a dentist
//                             or a lawn crew, which costs nothing, and are real
//                             for any hospitality client we take on.
const GBP_METRICS = [
  'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS',
  'BUSINESS_FOOD_ORDERS', 'BUSINESS_FOOD_MENU_CLICKS',
];

export async function pullGbpMonthly(site, { months = 18, log = () => {} } = {}) {
  const ref = site.gbp_oauth_token_ref;
  // Stored as 'accounts/{acct}/locations/{id}' â€” the Performance API path
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
    // The four-way split, not just the search/maps totals. "Mobile maps is 70%
    // of your visibility" is a different instruction from "maps is 70%" — one
    // says fix the listing, the other says fix the mobile site.
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_desktop_search', value: a.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0 });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_mobile_search', value: a.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0 });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_desktop_maps', value: a.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0 });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_impr_mobile_maps', value: a.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0 });
    if (impr > 0) {
      rows.push({ ym: m, source: 'gbp', key: 'gbp_mobile_share', value: Number(((((a.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0) + (a.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0)) / impr) * 100).toFixed(1)) });
    }

    // Messages and bookings are LEADS. They were never requested, so every
    // conversation a customer started from the listing was invisible to us.
    const convos = a.BUSINESS_CONVERSATIONS || 0;
    const bookings = a.BUSINESS_BOOKINGS || 0;
    rows.push({ ym: m, source: 'gbp', key: 'gbp_conversations', value: convos });
    rows.push({ ym: m, source: 'gbp', key: 'gbp_bookings', value: bookings });
    if ((a.BUSINESS_FOOD_ORDERS || 0) > 0) rows.push({ ym: m, source: 'gbp', key: 'gbp_food_orders', value: a.BUSINESS_FOOD_ORDERS });
    if ((a.BUSINESS_FOOD_MENU_CLICKS || 0) > 0) rows.push({ ym: m, source: 'gbp', key: 'gbp_food_menu_clicks', value: a.BUSINESS_FOOD_MENU_CLICKS });

    // Total actions now includes messages and bookings, so the action rate
    // stops under-reporting the listings that get contacted rather than called.
    const actions = calls + dirs + web + convos + bookings;
    rows.push({ ym: m, source: 'gbp', key: 'gbp_actions_total', value: actions });
    if (impr > 0) rows.push({ ym: m, source: 'gbp', key: 'gbp_action_rate', value: Number(((actions / impr) * 100).toFixed(2)) });
  }
  log(`gbp ${location}: ${perMonth.size} months`);
  return { rows };
}

// â”€â”€ GBP listing search keywords (Ingestion Phase 2, 2026-07-26) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The actual queries that surfaced the listing â€” searchkeywords API, monthly.
// Low-volume terms come back as a threshold ("<15"); we store the threshold
// value so the report can show "â‰¤15" honestly.
export async function pullGbpSearchKeywords(site, { months = 6, log = () => {} } = {}) {
  const ref = site.gbp_oauth_token_ref;
  const location = site.gbp_location_name?.match(/locations\/[^/]+$/)?.[0] || null;
  if (!ref || !location) return { rows: [], reason: 'no token or location' };
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) return { rows: [], reason: 'refresh failed' };

  const rows = [];
  const now = new Date();
  for (let m = months; m >= 1; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const ymLabel = ym(d);
    const params = new URLSearchParams();
    params.append('monthlyRange.start_month.year', String(d.getUTCFullYear()));
    params.append('monthlyRange.start_month.month', String(d.getUTCMonth() + 1));
    params.append('monthlyRange.end_month.year', String(d.getUTCFullYear()));
    params.append('monthlyRange.end_month.month', String(d.getUTCMonth() + 1));
    params.append('pageSize', '75');
    try {
      const data = await gFetch(tok.access_token, 'GET',
        `https://businessprofileperformance.googleapis.com/v1/${location}/searchkeywords/impressions/monthly?${params}`);
      for (const k of data.searchKeywordsCounts || []) {
        const v = Number(k.insightsValue?.value ?? k.insightsValue?.threshold ?? 0);
        if (!k.searchKeyword || !isFinite(v)) continue;
        rows.push({ ym: ymLabel, source: 'gbp', key: 'gbp_search_keyword_impressions', dim: 'keyword', dimv: String(k.searchKeyword).slice(0, 200), value: v });
      }
    } catch (e) {
      log(`gbp searchkeywords ${ymLabel} skipped: ${e.message.slice(0, 90)}`);
    }
  }
  return { rows };
}

// â”€â”€ SE Ranking keyword meta (volume / CPC) â†’ keyword dimension extras â”€â”€â”€â”€â”€â”€
// The /keywords endpoint returns names only; volume/cpc/competition ride on
// the /positions payload's keyword objects (verified 2026-07-26), so pull a
// minimal 2-day positions window and read the meta off the primary engine.
export async function pullSeKeywordMeta(site, { log = () => {} } = {}) {
  const projectId = site.se_ranking_project_id;
  if (!projectId) return { rows: [], reason: 'no SE project' };
  // SE Ranking cost gate (Brandon 2026-08-21): no SE Ranking call for a site
  // without an active paid SEO add-on — a project id alone is not enough.
  if (!site.seo_addon_tier) return { rows: [], reason: 'no SEO add-on' };
  try {
    const { getKeywordPositions } = await import('./seranking.js');
    const res = await getKeywordPositions(projectId, site.tenant_id); // today's reading; volume/cpc ride on the keyword objects
    const blocks = Array.isArray(res) ? res : res?.data || [];
    const kws = blocks[0]?.keywords || [];
    const m = ym(new Date());
    const rows = [];
    for (const k of kws) {
      const name = String(k.name || '').slice(0, 200);
      if (!name) continue;
      if (k.volume != null && isFinite(Number(k.volume))) rows.push({ ym: m, source: 'seranking', key: 'kw_volume', dim: 'keyword', dimv: name, value: Number(k.volume) });
      if (k.cpc != null && isFinite(Number(k.cpc))) rows.push({ ym: m, source: 'seranking', key: 'kw_cpc', dim: 'keyword', dimv: name, value: Number(k.cpc) });
    }
    return { rows };
  } catch (e) {
    log(`se keyword meta skipped: ${e.message.slice(0, 120)}`);
    return { rows: [], reason: e.message.slice(0, 120) };
  }
}

// â”€â”€ SE Ranking backlinks â†’ monthly series + per-domain dims â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function aggregateBacklinksMonthly(pool, site) {
  const res = await pool.request()
    .input('tid', sql.UniqueIdentifier, site.tenant_id)
    .input('sid', sql.UniqueIdentifier, site.site_id)
    .query(`
      WITH monthly AS (
        SELECT DATEFROMPARTS(YEAR(snapshot_date), MONTH(snapshot_date), 1) pm,
               referring_domain, COUNT(*) links
        FROM arion.se_ranking_backlink_snapshot
        WHERE site_id = @sid
        GROUP BY DATEFROMPARTS(YEAR(snapshot_date), MONTH(snapshot_date), 1), referring_domain
      ), agg AS (
        SELECT pm, 'backlinks' mk, CAST(NULL AS nvarchar(40)) dim, CAST(NULL AS nvarchar(200)) dimv, CAST(SUM(links) AS decimal(18,4)) v FROM monthly GROUP BY pm
        UNION ALL SELECT pm, 'referring_domains', NULL, NULL, COUNT(DISTINCT referring_domain) FROM monthly GROUP BY pm
        UNION ALL SELECT pm, 'rd_backlinks', 'domain', LEFT(referring_domain, 200), links FROM monthly
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

// â”€â”€ MERGE into arion.metric_monthly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ SE Ranking monthly aggregation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Aggregates own-site position history (captured daily by the arion-func
// Market Monitor moves job, backfilled 2026-07-25) into kw_* monthly rows on
// the canonical engine (the site's engine with the most rows â€” Google
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
 * The monthly refresh â€” every site, every source, RECENT months only
 * (the deep backfill was a one-time script; this keeps it current).
 * Called by POST /internal/insights-snapshot-tick from the arion-func timer.
 */
export async function runFullInsightsSnapshot(pool, log = () => {}) {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain, gbp_oauth_token_ref, gsc_oauth_token_ref,
           gsc_site_url, ga4_property_id, gbp_location_name, se_ranking_project_id,
           seo_addon_tier
    FROM arion.site WHERE domain IS NOT NULL`)).recordset;

  const summary = { sites: sites.length, seranking: 0, backlinks: 0, results: {} };
  for (const site of sites) {
    try {
      summary.seranking += await aggregateSeRankingMonthly(pool, site);
      summary.backlinks += await aggregateBacklinksMonthly(pool, site);
      summary.results[site.domain] = await snapshotGoogleSources(pool, site, {
        gscMonths: 2, ga4Months: 2, gbpMonths: 2, gbpKeywordMonths: 2, log: (m) => log(`${site.domain}: ${m}`),
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
    ['gbp_keywords', pullGbpSearchKeywords, { months: opts.gbpKeywordMonths ?? 6, log }],
    ['gbp_reviews', pullGbpReviews, { log }],
    ['se_meta', pullSeKeywordMeta, { log }],
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
