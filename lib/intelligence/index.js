// lib/intelligence/index.js — ARION Intelligence aggregator.
//
// Brandon's locked architecture (2026-06-21):
//   Platform Pulse = (Trend Score + Intelligence Score) / 2
//   Business Pulse = avg(active Platform Pulses) — equal weight
//
// Each ARION Intelligence calculator MUST be single-source — no SPARK,
// OLIVER, GBP, or other cross-platform blends. Cross-platform intelligence
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

// 2026-06-22 — Doc 64 canonical rework: ARION Intelligence expanded from 6
// to 9 reports. The 6 NEW reports below are registered with
// pending_implementation calculator stubs in Phase 1; full calculators
// ship in doc-64 Phases 2-4.
export const KEY_PSI_DECAY       = 'pagespeed_decay_forecast';
export const KEY_AUDIT_RISK      = 'site_audit_risk_prediction';
export const KEY_KW_TRAJ         = 'keyword_position_trajectory';
export const KEY_BL_ANOMALY      = 'backlink_velocity_anomaly';
export const KEY_CONTENT_CLUSTER = 'content_quality_cluster';
export const KEY_LOCAL_PACK      = 'local_pack_visibility_forecast';
export const KEY_CRAWL_BUDGET    = 'crawl_budget_optimization';
export const KEY_COMP_GAP        = 'competitive_presence_gap';

// Doc-64 §4.2 canonical 9-report shelf. Order matters — this is the
// rendered order in the Portal. Legacy keys (KEY_SEO / KEY_CRAWL /
// KEY_SCHEMA / KEY_PSI / KEY_COMP) remain in CALCULATORS so cached
// payloads still resolve, but they're demoted out of the shelf and now
// feed §4.2 reports as score-inputs.
export const ARION_INTEL_REPORTS = [
  KEY_TRAJ,
  KEY_PSI_DECAY,
  KEY_AUDIT_RISK,
  KEY_KW_TRAJ,
  KEY_BL_ANOMALY,
  KEY_CONTENT_CLUSTER,
  KEY_LOCAL_PACK,
  KEY_CRAWL_BUDGET,
  KEY_COMP_GAP,
];

const ALL_NEW_KEYS = new Set(ARION_INTEL_REPORTS);

// 2026-06-22 — Doc 64 §2: Intelligence is no longer a flat tier wall.
// Until the SEO addon catalog is retiered to standard/pro/business in a
// separate workflow, every SEO-tier gets the same unlock set; the
// per-report gate in REPORT_MIN_TIER below is what actually limits access.
export const TIER_UNLOCKS = {
  standard:   ALL_NEW_KEYS,
  pro:        ALL_NEW_KEYS,
  business:   ALL_NEW_KEYS,
  starter:    ALL_NEW_KEYS,
  essentials: ALL_NEW_KEYS,
  growth:     ALL_NEW_KEYS,
  authority:  ALL_NEW_KEYS,
};

/** Map an unknown / unset tier to the safest unlock set (starter). */
function unlockedFor(tier) {
  const key = String(tier || '').toLowerCase();
  return TIER_UNLOCKS[key] || TIER_UNLOCKS.starter;
}

/** Pretty label for the gating UI. */
export const REPORT_LABEL = {
  [KEY_TRAJ]:            'Visibility Trajectory',
  [KEY_PSI_DECAY]:       'PageSpeed Decay Forecast',
  [KEY_AUDIT_RISK]:      'Site Audit Risk Prediction',
  [KEY_KW_TRAJ]:         'Keyword Position Trajectory',
  [KEY_BL_ANOMALY]:      'Backlink Velocity Anomaly',
  [KEY_CONTENT_CLUSTER]: 'Content Quality Cluster',
  [KEY_LOCAL_PACK]:      'Local Pack Visibility Forecast',
  [KEY_CRAWL_BUDGET]:    'Crawl Budget Optimization',
  [KEY_COMP_GAP]:        'Competitive Presence Gap',
  // Legacy (demoted to score-input — kept for cache compatibility)
  [KEY_SEO]:    'SEO Authority Position',
  [KEY_COMP]:   'Competitive Presence Gap',
  [KEY_CRAWL]:  'Crawl Depth Score',
  [KEY_SCHEMA]: 'Schema Markup Coverage',
  [KEY_PSI]:    'Page Speed Distribution',
};

/** The single-source data source label, for the UI badge. */
export const REPORT_SOURCE = {
  [KEY_TRAJ]:            'Google Search Console',
  [KEY_PSI_DECAY]:       'PageSpeed Insights + IA Plugin',
  [KEY_AUDIT_RISK]:      'SE Ranking audit history',
  [KEY_KW_TRAJ]:         'SE Ranking position history',
  [KEY_BL_ANOMALY]:      'SE Ranking backlink stats',
  [KEY_CONTENT_CLUSTER]: 'IA Plugin RankMath + GA4 + GSC',
  [KEY_LOCAL_PACK]:      'GBP insights + reviews',
  [KEY_CRAWL_BUDGET]:    'SE Ranking audit + GSC index coverage',
  [KEY_COMP_GAP]:        'SE Ranking competitor visibility',
  // Legacy
  [KEY_SEO]:    'SE Ranking',
  [KEY_COMP]:   'SE Ranking',
  [KEY_CRAWL]:  'SE Ranking audit',
  [KEY_SCHEMA]: 'SE Ranking + IA Plugin',
  [KEY_PSI]:    'PageSpeed Insights',
};

/**
 * Phase-1 pending-implementation calculator stub. NEW doc-64 reports
 * register with one of these so the aggregator returns a renderable
 * shell (state: 'insufficient_data', narrative explains pending). Full
 * calculators ship in doc-64 Phases 2-4.
 */
function pendingImplementationStub(reportKey, dataFloor) {
  return async function pendingCalculator() {
    return {
      reportKey,
      score: null,
      tier: null,
      state: 'insufficient_data',
      components: [],
      narrative: `Pending implementation — ships in doc-64 Phase 2-4 (data floor: ${dataFloor}).`,
      observations: [
        `Registered as a Phase-1 shell per doc 64 §8. Card renders so the structure is visible; calculator queued for the matching phase.`,
      ],
      actions: [],
      dataGap: `Pending implementation. Required data floor: ${dataFloor}.`,
      last_calculated_at: new Date().toISOString(),
    };
  };
}

const CALCULATORS = {
  // KEPT — real calculators
  [KEY_TRAJ]:     calculateVisibilityTrajectory,
  [KEY_COMP_GAP]: calculateCompetitivePresence,

  // NEW — Phase-1 stubs (calculators land in Phase 2-4)
  [KEY_PSI_DECAY]:       pendingImplementationStub(KEY_PSI_DECAY,       '2 snapshots for distribution / 30+ for forecast'),
  [KEY_AUDIT_RISK]:      pendingImplementationStub(KEY_AUDIT_RISK,      '3 completed audits'),
  [KEY_KW_TRAJ]:         pendingImplementationStub(KEY_KW_TRAJ,         '90d position history'),
  [KEY_BL_ANOMALY]:      pendingImplementationStub(KEY_BL_ANOMALY,      '60d backlink snapshots'),
  [KEY_CONTENT_CLUSTER]: pendingImplementationStub(KEY_CONTENT_CLUSTER, 'Plugin installed + 30d GA4'),
  [KEY_LOCAL_PACK]:      pendingImplementationStub(KEY_LOCAL_PACK,      '60d (90d for confident forecast)'),
  [KEY_CRAWL_BUDGET]:    pendingImplementationStub(KEY_CRAWL_BUDGET,    '1 audit + 90d GSC'),

  // LEGACY — demoted to score-input (kept until cache TTL drains)
  [KEY_SEO]:    calculateSeoAuthority,
  [KEY_COMP]:   calculateCompetitivePresence,
  [KEY_CRAWL]:  calculateCrawlDepth,
  [KEY_SCHEMA]: calculateSchemaCoverage,
  [KEY_PSI]:    calculatePageSpeedDistribution,
};

/** Minimum tier required to unlock each report (per doc-64 §4.2). */
const REPORT_MIN_TIER = {
  [KEY_TRAJ]:            'standard',
  [KEY_PSI_DECAY]:       'standard',
  [KEY_LOCAL_PACK]:      'standard',
  [KEY_AUDIT_RISK]:      'pro',
  [KEY_KW_TRAJ]:         'pro',
  [KEY_BL_ANOMALY]:      'pro',
  [KEY_CONTENT_CLUSTER]: 'pro',
  [KEY_COMP_GAP]:        'pro',
  [KEY_CRAWL_BUDGET]:    'business',
  // Legacy
  [KEY_SEO]:    'standard',
  [KEY_COMP]:   'pro',
  [KEY_CRAWL]:  'pro',
  [KEY_SCHEMA]: 'business',
  [KEY_PSI]:    'standard',
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
