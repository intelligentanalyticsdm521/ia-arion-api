// lib/intelligence/utils.js — shared helpers for the 6 Intelligence calculators.
//
// Each calculator returns the same shape:
//   {
//     reportKey,               // canonical key matching arion.intelligence_cache.report_key
//     score,                   // 0-100 integer (null when insufficient_data)
//     tier,                    // 'A' | 'B' | 'C' | 'D' | null
//     state,                   // 'ok' | 'partial' | 'insufficient_data'
//     components: [            // top-3 weighted inputs for the gauge breakdown
//       { key, value, weight, note }
//     ],
//     narrative,               // 1-2 sentence headline shown on the card
//     observations: [],        // detail observations shown in the modal
//     actions: [],             // recommended next-actions shown in the modal
//     dataGap,                 // optional: human-readable "what's missing"
//     last_calculated_at       // ISO timestamp stamped at result time
//   }
//
// The cache TTL is 12 hours. The route layer wraps each call and stores
// payload_json in arion.intelligence_cache.

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Clamp n into [lo, hi]. NaN/null → lo. */
export function clamp(n, lo = 0, hi = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** Map a 0-100 score to a tier letter. */
export function scoreToTier(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

/** Build the "insufficient_data" early-exit shape. */
export function insufficient(reportKey, narrative, dataGap, observations = []) {
  return {
    reportKey,
    score: null,
    tier: null,
    state: 'insufficient_data',
    components: [],
    narrative,
    observations,
    actions: [],
    dataGap,
    last_calculated_at: new Date().toISOString(),
  };
}

/** Build the locked-tier stub returned when a Lite tenant requests a report. */
export function locked(reportKey, narrative, requiredTier = 'standard') {
  return {
    reportKey,
    score: null,
    tier: null,
    state: 'locked',
    locked: true,
    requiredTier,
    components: [],
    narrative,
    observations: [],
    actions: [],
    dataGap: `Upgrade to ${requiredTier.toUpperCase()} or above to unlock this report.`,
    last_calculated_at: new Date().toISOString(),
  };
}

/** Build a successful result. Score is clamped + tier derived. */
export function result(reportKey, score, components, narrative, observations = [], actions = [], state = 'ok', dataGap = undefined) {
  const safeScore = clamp(Math.round(Number(score) || 0));
  return {
    reportKey,
    score: safeScore,
    tier: scoreToTier(safeScore),
    state,
    components: (components || []).slice(0, 3),
    narrative,
    observations,
    actions,
    ...(dataGap ? { dataGap } : {}),
    last_calculated_at: new Date().toISOString(),
  };
}

/** Safe number formatter — null/undefined/NaN → '0'. */
export const fmtNum = (n) => (n == null || !Number.isFinite(Number(n)) ? '0' : Math.round(Number(n)).toLocaleString());
export const fmtPct = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '0%' : `${(Number(n) * 100).toFixed(d)}%`);

// ─── F-Onb-D7: Signal Registry + Site-Age Multiplier ─────────────────────
//
// Canonical signal → tier + label + source map. Calculators self-report
// which signals they consumed (SIGNALS_USED array) so the modal / audit
// layer can show provenance and gate paid signals cleanly.
//
// Tiers:
//   'free'            — always available (GSC, PSI, IA Plugin free hooks)
//   'paid-seranking'  — requires SE Ranking add-on
//
// Only the 6 currently-active calculators tag signals. Demoted legacy
// keys are skipped.
export const SIGNAL_REGISTRY = {
  // GSC — always free
  'gsc.impressions_trend':      { tier: 'free', label: 'GSC impressions trend', source: 'Google Search Console' },
  'gsc.projected_impressions':  { tier: 'free', label: 'GSC projected impressions', source: 'Google Search Console' },
  'gsc.avg_position':           { tier: 'free', label: 'GSC average position', source: 'Google Search Console' },
  // PSI — always free
  'psi.snapshot':               { tier: 'free', label: 'PageSpeed Insights snapshot', source: 'PageSpeed Insights API' },
  'psi.cwv.lcp':                { tier: 'free', label: 'Core Web Vitals — LCP', source: 'PageSpeed Insights API' },
  'psi.cwv.cls':                { tier: 'free', label: 'Core Web Vitals — CLS', source: 'PageSpeed Insights API' },
  'psi.cwv.inp':                { tier: 'free', label: 'Core Web Vitals — INP', source: 'PageSpeed Insights API' },
  // IA Plugin — free tier
  'plugin.rankmath':             { tier: 'free', label: 'RankMath schema coverage', source: 'IA Plugin' },
  'plugin.security':             { tier: 'free', label: 'Wordfence security signals', source: 'IA Plugin (Wordfence)' },
  // SE Ranking — paid add-on
  'seranking.own_visibility':    { tier: 'paid-seranking', label: 'SE Ranking own visibility', source: 'SE Ranking API' },
  'seranking.competitor_avg':    { tier: 'paid-seranking', label: 'SE Ranking competitor avg', source: 'SE Ranking API' },
  'seranking.referring_domains': { tier: 'paid-seranking', label: 'SE Ranking referring domains', source: 'SE Ranking API' },
  'seranking.dofollow_backlinks':{ tier: 'paid-seranking', label: 'SE Ranking dofollow backlinks', source: 'SE Ranking API' },
  'seranking.gap_count':         { tier: 'paid-seranking', label: 'SE Ranking gap count', source: 'SE Ranking API' },
  'seranking.gap_rate':          { tier: 'paid-seranking', label: 'SE Ranking gap rate', source: 'SE Ranking API' },
  'seranking.keywords_tracked':  { tier: 'paid-seranking', label: 'SE Ranking keywords tracked', source: 'SE Ranking API' },
  'seranking.audit':             { tier: 'paid-seranking', label: 'SE Ranking site audit', source: 'SE Ranking API' },
};

/**
 * Site-age dampener. Returns [0.5, 1.0] based on how long the site row has
 * existed. Sites 7 days old or younger get 0.5 (half score); sites 30+ days
 * old get 1.0 (no dampening); linear ramp between. Applied to raw scores
 * BEFORE clamp(0-100) + tier derivation.
 *
 * @param {Date|string|null} createdAt
 * @returns {number} multiplier in [0.5, 1.0]
 */
export function siteAgeMultiplier(createdAt) {
  if (!createdAt) return 1.0; // unknown → no dampening
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (isNaN(created.getTime())) return 1.0;
  const ageMs = Date.now() - created.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays >= 30) return 1.0;
  if (ageDays <= 7) return 0.5;
  // Linear ramp from (7d, 0.5) to (30d, 1.0)
  return 0.5 + (ageDays - 7) * (0.5 / 23);
}

/**
 * Applies a siteAgeMultiplier (or any [0,1]-ish multiplier) to a raw score.
 * Rounds to nearest integer. NULL/NaN scores pass through unchanged so
 * insufficient_data payloads are never accidentally converted to 0.
 *
 * @param {number|null} rawScore
 * @param {number} multiplier — nullable; treated as 1.0 when non-numeric
 * @returns {number|null}
 */
export function applyAgeMultiplier(rawScore, multiplier) {
  if (rawScore == null || Number.isNaN(rawScore)) return rawScore;
  const m = typeof multiplier === 'number' && !Number.isNaN(multiplier) ? multiplier : 1.0;
  return Math.round(rawScore * m);
}

