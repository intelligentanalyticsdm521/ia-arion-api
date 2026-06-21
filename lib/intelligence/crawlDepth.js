// lib/intelligence/crawlDepth.js — Crawl Depth Score calculator.
//
// REPORT 4 of 6 (single-source: SE Ranking audit).
//
// Measures how completely the SE Ranking crawler reached your site on its
// most recent audit. Composite of:
//   - % of pages reached vs declared indexable universe
//   - Average crawl depth (clicks from homepage) — closer to homepage =
//     better internal-link distribution
//   - 4xx/5xx ratio on crawl
//   - Orphaned-page count
//
// Higher is better. A high score means your site architecture is healthy
// enough for crawlers to find everything. A low score signals broken
// internal links, deep-buried pages, robots.txt issues, or server errors.
//
// Single-source compliance (locked 2026-06-21): reads ONLY SE Ranking
// audit data via getAuditSummary + getAuditSections.
//
// Falls back to insufficient_data when no audit has run yet (audits run
// quarterly on Starter, monthly on Essentials/Growth, weekly on Authority
// per the tier matrix).

import { fmtNum, insufficient, result } from './utils.js';
import { getAuditSummary, getAuditSections } from '../seranking.js';

export const REPORT_KEY = 'crawl_depth';

export async function calculateCrawlDepth(ctx) {
  const { seRankingAuditId, seRankingProjectId, tenantId } = ctx;

  if (!seRankingProjectId) {
    return insufficient(
      REPORT_KEY,
      'SE Ranking not connected',
      'Add the IA SEO package to provision an SE Ranking project — required for crawl analysis.',
      ['Crawl Depth reads the most recent SE Ranking site audit, which requires a connected SE Ranking project.'],
    );
  }

  if (!seRankingAuditId) {
    return insufficient(
      REPORT_KEY,
      'No audit run yet',
      'Run your first SE Ranking site audit — it seeds the crawl-depth baseline.',
      ['The SE Ranking project is connected but no audit has completed yet. Audits run quarterly on Starter, monthly on Essentials/Growth, and weekly on Authority.'],
    );
  }

  const [summary, sections] = await Promise.all([
    getAuditSummary(seRankingAuditId, tenantId).catch(() => null),
    getAuditSections(seRankingAuditId, tenantId).catch(() => []),
  ]);

  if (!summary) {
    return insufficient(
      REPORT_KEY,
      'Audit data unavailable',
      'SE Ranking returned no audit summary — likely transient API hiccup. Refresh shortly.',
      ['getAuditSummary returned null. Cached intelligence will refresh on the next 12-hour cycle or manual recalculate.'],
    );
  }

  // SE Ranking audit summary returns crawl-level signals under various field
  // names depending on the audit version. Be defensive across both.
  const pagesCrawled = Number(summary?.pages_crawled ?? summary?.crawled_pages ?? summary?.total_pages ?? 0);
  const pagesIndexable = Number(summary?.pages_indexable ?? summary?.indexable_pages ?? summary?.indexable_count ?? pagesCrawled);
  const avgDepth = Number(summary?.average_depth ?? summary?.avg_depth ?? summary?.crawl_depth_avg ?? 0);
  const errors4xx = Number(summary?.errors_4xx ?? summary?.client_errors ?? 0);
  const errors5xx = Number(summary?.errors_5xx ?? summary?.server_errors ?? 0);

  // Orphans count — pull from sections if available.
  const orphanSection = Array.isArray(sections)
    ? sections.find((s) => /orphan/i.test(String(s?.code || s?.key || s?.name || '')))
    : null;
  const orphanCount = Number(orphanSection?.count ?? orphanSection?.total ?? 0);

  // Crawl coverage: % of indexable pages reached. Cap denominator at
  // max(1) to avoid div-by-zero on tiny sites.
  const coverage = pagesIndexable > 0 ? Math.min(1, pagesCrawled / pagesIndexable) : 0;
  // Depth quality: 1 if avg depth ≤ 3 (industry healthy), linearly degrades to 0 at depth 8.
  const depthQuality = avgDepth > 0
    ? Math.max(0, Math.min(1, (8 - avgDepth) / 5))
    : 0.5;  // unknown depth — neutral
  // Error penalty: 4xx/5xx as % of crawled pages.
  const errorRate = pagesCrawled > 0 ? (errors4xx + errors5xx) / pagesCrawled : 0;

  // Score (0-100):
  //   60% coverage + 25% depth quality + 15% (1 - errorRate*2) — clamped.
  const score = Math.round(Math.max(0, Math.min(100,
    coverage * 60 + depthQuality * 25 + Math.max(0, 1 - errorRate * 2) * 15
  )));

  const observations = [];
  observations.push(`Crawl coverage: ${fmtNum(pagesCrawled)} of ${fmtNum(pagesIndexable)} indexable pages reached (${(coverage * 100).toFixed(1)}%).`);
  observations.push(`Average crawl depth: ${avgDepth.toFixed(1)} clicks from homepage. ${avgDepth <= 3 ? 'Healthy — most content is 2-3 clicks deep.' : avgDepth <= 5 ? 'Moderate — some pages buried 5+ clicks from home.' : 'Deep — significant content is 6+ clicks from home, crawlers may skip it.'}`);
  if (errors4xx > 0 || errors5xx > 0) {
    observations.push(`Crawl errors: ${fmtNum(errors4xx)} 4xx + ${fmtNum(errors5xx)} 5xx. Every 4xx is an internal link pointing at a missing page; every 5xx is a transient hosting issue worth investigating.`);
  }
  if (orphanCount > 0) {
    observations.push(`${fmtNum(orphanCount)} orphaned pages — published but nothing internally links to them. Search engines won't discover these reliably.`);
  }

  const actions = [];
  if (coverage < 0.8) {
    actions.push(`Crawler reached only ${(coverage * 100).toFixed(0)}% of indexable pages. Audit your robots.txt + XML sitemap completeness, then re-trigger an SE Ranking audit.`);
  }
  if (avgDepth > 5) {
    actions.push(`Avg depth ${avgDepth.toFixed(1)} is too deep. Add category landing pages or expand site navigation — every level closer to home boosts discoverability.`);
  }
  if (errors4xx >= 5) {
    actions.push(`Fix the ${fmtNum(errors4xx)} 4xx errors first — these are broken internal links wasting crawl budget on dead targets.`);
  }
  if (orphanCount > 0) {
    actions.push(`Add internal links from related/category pages to the ${fmtNum(orphanCount)} orphaned URLs, or set them noindex if they're intentional dead-ends.`);
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'crawl_coverage_pct', value: Math.round(coverage * 100), weight: 0.6, note: 'pages reached vs indexable' },
      { key: 'avg_crawl_depth', value: Number(avgDepth.toFixed(1)), weight: 0.25, note: 'clicks from homepage' },
      { key: 'error_rate_pct', value: Number((errorRate * 100).toFixed(1)), weight: 0.15, note: '4xx + 5xx vs crawled' },
    ],
    `${(coverage * 100).toFixed(0)}% coverage · depth ${avgDepth.toFixed(1)} · ${fmtNum(errors4xx + errors5xx)} errors`,
    observations,
    actions,
  );
}
