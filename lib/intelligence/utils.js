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
