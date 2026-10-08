// lib/demoData.js — DEV-ONLY seeded-data provider for the demo tenants.
//
// WHY THIS EXISTS
// ---------------
// The ARION trend engines score from LIVE API responses — GA4, Search Console,
// Google Business Profile, PageSpeed. The demo tenants have no OAuth tokens and
// no GA4 property, so every one of those calls returns nothing and all six
// reports resolve to `unmeasured`. Seeding database tables did not help: the
// scoring path never reads them.
//
// The practical effect was that the entire Insights surface could not be
// demoed, walked, or verified against the demo book — every card said
// "connect X" (found 2026-07-24).
//
// This module serves the SAME response shapes the live endpoints return, built
// from the rows the dev seeder writes. It is strictly gated:
//
//   * enabled only when ARION_DEMO_DATA=true (set in the dev .env, never prod)
//   * and only for a site with NO live connection, so a genuinely connected
//     tenant always wins
//
// Prod behaviour is therefore byte-identical with the flag unset.

import sql from 'mssql';
import { hasSiteToken } from './gbpTokenAtRest.js';

export function demoDataEnabled() {
  return String(process.env.ARION_DEMO_DATA || '').toLowerCase() === 'true';
}

/** Deterministic pseudo-random in [0,1) from a string seed — same site, same numbers. */
function seeded(str, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const round = (n) => Math.round(n);

/**
 * GA4-shaped analytics built from arion.site_page_view_daily, which the seeder
 * populates with real per-day, per-page rows.
 */
export async function demoAnalytics(pool, site, days = 90) {
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .input('days', sql.Int, days)
    .query(`SELECT day_utc, page_path, view_count, unique_visitors
            FROM arion.site_page_view_daily
            WHERE site_id = @siteId AND day_utc >= DATEADD(day, -@days, CAST(GETUTCDATE() AS DATE))
            ORDER BY day_utc`);
  const rows = r.recordset || [];
  if (!rows.length) return null;

  const byDay = new Map();
  const byPage = new Map();
  for (const row of rows) {
    const d = row.day_utc.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + row.view_count);
    byPage.set(row.page_path, (byPage.get(row.page_path) || 0) + row.view_count);
  }

  const totalPageviews = rows.reduce((s, x) => s + x.view_count, 0);
  const totalUsers = rows.reduce((s, x) => s + x.unique_visitors, 0);
  const totalSessions = round(totalUsers * 1.18);
  const s = (salt) => seeded(site.domain || site.site_id, salt);

  const engagementRate = 0.42 + s(1) * 0.24;          // 42-66%
  const bounceRate = 1 - engagementRate;
  const mobilePct = round(52 + s(2) * 22);            // 52-74%
  const tabletPct = round(2 + s(3) * 4);
  const desktopPct = 100 - mobilePct - tabletPct;
  const formSubmissions = round(totalSessions * (0.008 + s(4) * 0.022));

  const sessionsByDay = [...byDay.entries()].map(([date, views]) => ({ date, sessions: round(views * 0.62) }));
  // Prior period, so month-over-month comparisons are real rather than absent.
  const priorFactor = 0.82 + s(5) * 0.3;

  const channels = [
    { channel: 'Organic Search', share: 0.38 + s(6) * 0.14 },
    { channel: 'Direct',         share: 0.22 + s(7) * 0.10 },
    { channel: 'Referral',       share: 0.10 + s(8) * 0.08 },
    { channel: 'Organic Social', share: 0.08 + s(9) * 0.07 },
    { channel: 'Paid Search',    share: 0.04 + s(10) * 0.05 },
  ];
  const chTotal = channels.reduce((a, c) => a + c.share, 0);
  const channelBreakdown = channels.map((c) => ({
    channel: c.channel,
    sessions: round(totalSessions * (c.share / chTotal)),
  }));

  const topPages = [...byPage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([page, views]) => ({ page, views, sessions: round(views * 0.62) }));

  const city = site.city || 'Des Moines';
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(); start.setUTCDate(start.getUTCDate() - days);

  return {
    connected: true,
    demo: true,
    period: days,
    dateRange: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    summary: {
      totalSessions, totalUsers, totalPageviews,
      bounceRate, formSubmissions,
    },
    engagement: {
      engagedSessions: round(totalSessions * engagementRate),
      engagementRate,
      avgSessionDuration: round(78 + s(11) * 90),
      pagesPerSession: Number((1.6 + s(12) * 1.3).toFixed(2)),
    },
    sessionsByDay,
    pageviewsByDay: [...byDay.entries()].map(([date, views]) => ({ date, pageviews: views })),
    channelBreakdown,
    deviceSplit: { mobile: mobilePct, desktop: desktopPct, tablet: tabletPct },
    topPages,
    landingPages: topPages.slice(0, 8),
    cities: [
      { city, sessions: round(totalSessions * (0.52 + s(13) * 0.2)) },
      { city: 'Ankeny', sessions: round(totalSessions * 0.14) },
      { city: 'West Des Moines', sessions: round(totalSessions * 0.11) },
      { city: 'Urbandale', sessions: round(totalSessions * 0.07) },
    ],
    newVsReturning: [
      { type: 'new', sessions: round(totalSessions * (0.6 + s(14) * 0.15)) },
      { type: 'returning', sessions: round(totalSessions * (0.4 - s(14) * 0.15)) },
    ],
    breakdowns: { pages: topPages },
    comparison: {
      summary: {
        totalSessions: round(totalSessions * priorFactor),
        totalUsers: round(totalUsers * priorFactor),
        totalPageviews: round(totalPageviews * priorFactor),
      },
      channelBreakdown: channelBreakdown.map((c, i) => ({
        channel: c.channel,
        sessions: round(c.sessions * (0.75 + seeded(c.channel, i) * 0.5)),
      })),
      deltas: {
        sessions: totalSessions - round(totalSessions * priorFactor),
        sessionsPct: round((1 - priorFactor) * 100),
      },
    },
  };
}

/** Search-Console-shaped payload built from arion.gsc_data. */
export async function demoSearchPerformance(pool, site, period = 90) {
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .input('days', sql.Int, period)
    .query(`SELECT query, page, device, clicks, impressions, ctr, position, report_date
            FROM arion.gsc_data
            WHERE site_id = @siteId AND report_date >= DATEADD(day, -@days, CAST(GETUTCDATE() AS DATE))`);
  const rows = r.recordset || [];
  if (!rows.length) return null;

  const agg = (keyFn) => {
    const m = new Map();
    for (const x of rows) {
      const k = keyFn(x);
      if (k == null) continue;
      const cur = m.get(k) || { clicks: 0, impressions: 0, posSum: 0, n: 0 };
      cur.clicks += x.clicks; cur.impressions += x.impressions;
      cur.posSum += Number(x.position) * x.impressions; cur.n += x.impressions;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({
        key: k,
        clicks: v.clicks,
        impressions: v.impressions,
        ctr: v.impressions ? v.clicks / v.impressions : 0,
        position: v.n ? v.posSum / v.n : 0,
      }))
      .sort((a, b) => b.impressions - a.impressions);
  };

  const totals = rows.reduce((a, x) => {
    a.clicks += x.clicks; a.impressions += x.impressions;
    a.posSum += Number(x.position) * x.impressions; a.n += x.impressions;
    return a;
  }, { clicks: 0, impressions: 0, posSum: 0, n: 0 });

  return {
    provider: 'google',
    demo: true,
    period,
    summary: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      avgPosition: totals.n ? totals.posSum / totals.n : 0,
    },
    breakdowns: {
      queries: agg((x) => x.query).slice(0, 25).map((x) => ({ query: x.key, ...x })),
      pages: agg((x) => x.page).slice(0, 20).map((x) => ({ page: x.key, ...x })),
      devices: agg((x) => x.device).map((x) => ({ device: x.key, ...x })),
      dates: [], countries: [], pageQueries: [],
    },
  };
}

/** GBP-shaped payload from arion.gbp_profile + arion.gbp_review. */
export async function demoGbp(pool, site) {
  const prof = await pool.request()
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .query(`SELECT TOP 1 * FROM arion.gbp_profile WHERE site_id = @siteId`);
  const row = prof.recordset?.[0];
  if (!row) return null;
  const s = (salt) => seeded(site.domain || site.site_id, salt);
  const impressions = round(2400 + s(20) * 5200);
  return {
    connected: true,
    demo: true,
    profile: {
      name: row.business_name || site.domain,
      primaryCategory: (row.categories || '').split(',')[0] || null,
      address: row.address || null,
      phone: row.phone || null,
      completeness: row.completeness_pct ?? null,
    },
    metrics: {
      impressions,
      calls: round(impressions * (0.012 + s(21) * 0.02)),
      directions: round(impressions * (0.018 + s(22) * 0.025)),
      websiteClicks: round(impressions * (0.03 + s(23) * 0.035)),
      impressionsMobileMaps: round(impressions * 0.41),
      impressionsDesktopMaps: round(impressions * 0.12),
      impressionsMobileSearch: round(impressions * 0.33),
    },
  };
}

/** Review payload from arion.gbp_review. */
export async function demoGbpReviews(pool, site) {
  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .query(`SELECT star_rating, review_text, reviewer_name, review_date, reply_text
            FROM arion.gbp_review WHERE site_id = @siteId ORDER BY review_date DESC`);
  const rows = r.recordset || [];
  if (!rows.length) return null;
  const reviews = rows.map((x) => ({
    starRating: x.star_rating,
    comment: x.review_text,
    reviewer: { displayName: x.reviewer_name },
    createTime: x.review_date,
    replyComment: x.reply_text || null,
  }));
  return {
    connected: true,
    demo: true,
    reviews,
    totalReviewCount: reviews.length,
    averageRating: reviews.reduce((a, x) => a + Number(x.starRating || 0), 0) / reviews.length,
  };
}

/**
 * Should demo data stand in for this site?
 *
 * Deliberately NOT "has no token". Dev sites accumulate stale OAuth refs from
 * past experiments — summitlawnco carried a real Google refresh token from an
 * earlier session, so the live path was taken, the call failed against a
 * domain that token has no access to, and the endpoint returned empty rather
 * than falling through to demo data. The reports scored 0 with no explanation.
 *
 * With ARION_DEMO_DATA on, demo data wins for every site: in dev nothing is
 * genuinely connected, and a stale token is worse than no token because it
 * looks connected while returning nothing. Each provider still returns null
 * when it has no seeded rows, so the caller falls through to the live path
 * for any site the seeder does not own.
 */
export function demoShouldServe(site) {
  return demoDataEnabled() && !!site;
}

/** @deprecated kept so older call sites keep compiling. */
export function siteIsUnconnected(site) {
  return !hasSiteToken(site) && !site?.ga4_property_id;
}
