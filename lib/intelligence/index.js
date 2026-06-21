// lib/intelligence/index.js — ARION Intelligence aggregator.
//
// Brandon's locked architecture (2026-06-21):
//   Platform Pulse = (Trend Score + Intelligence Score) / 2
//   Business Pulse = avg(active Platform Pulses) — equal weight
//
// Each ARION Intelligence calculator MUST be single-source — no SPARK,
// OLIVER, GBP, or other cross-platform blends. Cross-channel intelligence
// belongs to ARGUS (6 dedicated reports there, not duplicated here).
//
// The 6 single-source ARION reports:
//   1. seo_authority           (SE Ranking)
//   2. visibility_trajectory   (GSC)
//   3. competitive_presence    (SE Ranking)
//   4. crawl_depth             (SE Ranking audit)
//   5. schema_coverage         (SE Ranking audit + IA Plugin — both ARION-owned)
//   6. pagespeed_distribution  (PageSpeed Insights snapshots)
//
// Tier gating (per memory:reference_arion_seo_tier_matrix):
//   - Starter:    seo_authority, pagespeed_distribution
//   - Essentials: + visibility_trajectory, competitive_presence
//   - Growth:     + crawl_depth (5 total — drop schema_coverage)
//   - Authority:  all 6
//
// The aggregator returns each report's payload + the computed
// ARION Intelligence Score = average of unlocked report scores.

import { calculateSeoAuthority, REPORT_KEY as KEY_SEO } from './seoAuthority.js';
import { calculateVisibilityTrajectory, REPORT_KEY as KEY_TRAJ } from './visibilityTrajectory.js';
import { calculateCompetitivePresence, REPORT_KEY as KEY_COMP } from './competitivePresence.js';
import { calculateCrawlDepth, REPORT_KEY as KEY_CRAWL } from './crawlDepth.js';
import { calculateSchemaCoverage, REPORT_KEY as KEY_SCHEMA } from './schemaCoverage.js';
import { calculatePageSpeedDistribution, REPORT_KEY as KEY_PSI } from './pageSpeedDistribution.js';
import { locked, scoreToTier } from './utils.js';

export const ARION_INTEL_REPORTS = [
  KEY_SEO,
  KEY_TRAJ,
  KEY_COMP,
  KEY_CRAWL,
  KEY_SCHEMA,
  KEY_PSI,
];

/** Per-tier list of unlocked report keys. */
export const TIER_UNLOCKS = {
  starter:    new Set([KEY_SEO, KEY_PSI]),
  essentials: new Set([KEY_SEO, KEY_PSI, KEY_TRAJ, KEY_COMP]),
  growth:     new Set([KEY_SEO, KEY_PSI, KEY_TRAJ, KEY_COMP, KEY_CRAWL]),
  authority:  new Set([KEY_SEO, KEY_PSI, KEY_TRAJ, KEY_COMP, KEY_CRAWL, KEY_SCHEMA]),
};

/** Map an unknown / unset tier to the safest unlock set (starter). */
function unlockedFor(tier) {
  const key = String(tier || '').toLowerCase();
  return TIER_UNLOCKS[key] || TIER_UNLOCKS.starter;
}

/** Pretty label for the gating UI. */
export const REPORT_LABEL = {
  [KEY_SEO]:    'SEO Authority Position',
  [KEY_TRAJ]:   'Visibility Trajectory',
  [KEY_COMP]:   'Competitive Presence Gap',
  [KEY_CRAWL]:  'Crawl Depth Score',
  [KEY_SCHEMA]: 'Schema Markup Coverage',
  [KEY_PSI]:    'Page Speed Distribution',
};

/** The single-source data source label, for the UI badge. */
export const REPORT_SOURCE = {
  [KEY_SEO]:    'SE Ranking',
  [KEY_TRAJ]:   'Google Search Console',
  [KEY_COMP]:   'SE Ranking',
  [KEY_CRAWL]:  'SE Ranking audit',
  [KEY_SCHEMA]: 'SE Ranking + IA Plugin',
  [KEY_PSI]:    'PageSpeed Insights',
};

const CALCULATORS = {
  [KEY_SEO]:    calculateSeoAuthority,
  [KEY_TRAJ]:   calculateVisibilityTrajectory,
  [KEY_COMP]:   calculateCompetitivePresence,
  [KEY_CRAWL]:  calculateCrawlDepth,
  [KEY_SCHEMA]: calculateSchemaCoverage,
  [KEY_PSI]:    calculatePageSpeedDistribution,
};

/** Minimum tier required to unlock each report (for the locked stub). */
const REPORT_MIN_TIER = {
  [KEY_SEO]:    'starter',
  [KEY_PSI]:    'starter',
  [KEY_TRAJ]:   'essentials',
  [KEY_COMP]:   'essentials',
  [KEY_CRAWL]:  'growth',
  [KEY_SCHEMA]: 'authority',
};

/**
 * Run all 6 calculators against the supplied context and return:
 *   {
 *     reports: { [reportKey]: <calculatorResult> },
 *     intelligenceScore: 0-100 (avg of unlocked + non-null scores),
 *     intelligenceTier: 'A'|'B'|'C'|'D'|null,
 *     surface: 'arion',
 *     calculated_at: ISO,
 *   }
 *
 * @param {object} ctx
 * @param {string} ctx.tier — seo_addon_tier (starter|essentials|growth|authority)
 * @param {number} [ctx.seRankingProjectId]
 * @param {number} [ctx.seRankingAuditId]
 * @param {string} [ctx.tenantId]
 * @param {Array}  [ctx.gscDates]
 * @param {object} [ctx.pluginSeoAgg]
 * @param {number} [ctx.totalPages]
 * @param {Array}  [ctx.pageSpeedSnapshots]
 */
export async function runAllArionIntelligence(ctx = {}) {
  const unlocked = unlockedFor(ctx.tier);
  const minTierForLocked = (key) => REPORT_MIN_TIER[key] || 'authority';

  const reports = {};
  await Promise.all(ARION_INTEL_REPORTS.map(async (key) => {
    if (!unlocked.has(key)) {
      reports[key] = {
        ...locked(key, `${REPORT_LABEL[key]} requires ${minTierForLocked(key)} tier or above.`, minTierForLocked(key)),
        surface: 'arion',
        source: REPORT_SOURCE[key],
        label: REPORT_LABEL[key],
      };
      return;
    }
    try {
      const out = await CALCULATORS[key](ctx);
      reports[key] = {
        ...out,
        surface: 'arion',
        source: REPORT_SOURCE[key],
        label: REPORT_LABEL[key],
      };
    } catch (err) {
      console.error(`[intelligence/${key}] calculator threw:`, err.message);
      reports[key] = {
        reportKey: key,
        surface: 'arion',
        source: REPORT_SOURCE[key],
        label: REPORT_LABEL[key],
        score: null,
        tier: null,
        state: 'insufficient_data',
        components: [],
        narrative: 'Calculator error',
        observations: [`Calculator threw: ${err.message}. Auto-retries next refresh cycle.`],
        actions: [],
        dataGap: 'Transient calculator error.',
        last_calculated_at: new Date().toISOString(),
      };
    }
  }));

  // Intelligence Score: average of unlocked reports that have a numeric score.
  const numericScores = ARION_INTEL_REPORTS
    .filter((k) => unlocked.has(k))
    .map((k) => reports[k]?.score)
    .filter((s) => typeof s === 'number' && Number.isFinite(s));

  const intelligenceScore = numericScores.length > 0
    ? Math.round(numericScores.reduce((s, n) => s + n, 0) / numericScores.length)
    : null;

  return {
    surface: 'arion',
    reports,
    intelligenceScore,
    intelligenceTier: scoreToTier(intelligenceScore),
    activeReports: numericScores.length,
    totalReports: ARION_INTEL_REPORTS.length,
    unlockedReports: ARION_INTEL_REPORTS.filter((k) => unlocked.has(k)),
    tier: String(ctx.tier || '').toLowerCase() || null,
    calculated_at: new Date().toISOString(),
  };
}
