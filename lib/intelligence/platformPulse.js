// lib/intelligence/platformPulse.js — ARION Platform Pulse calculator.
//
// BRANDON'S FINAL INSIGHTS ARCHITECTURE (overrides any prior docx):
//   Platform Pulse = (Trend Score + Intelligence Score) / 2
//   Business Pulse = average of ALL active Platform Pulses (equal weight)
//
// "Active" = tenant subscribes to / has activated this product.
// "Single-source ONLY" — ARION Platform Pulse uses ARION data ONLY (no
// cross-platform). Cross-platform intelligence is ARGUS's domain.
//
// Components:
//   trend_component        — composite of all ARION Trend reports
//                            (rolled up from arion.ia_insights_score_history
//                            with report_key in trend list).
//   intelligence_component — composite of the 6 ARION Intelligence reports
//                            cached in arion.intelligence_cache (score 0-100
//                            per report; averaged across present reports).
//
// Rules:
//   - Both present: pulse = round((T + I) / 2, 1)
//   - Only trend:   pulse = T            (partial: true)
//   - Only intel:   pulse = I            (partial: true)
//   - Neither:      pulse = null         (no_data: true)
//
// Cache table: arion.platform_pulse_cache (migration 030). 6h TTL.

import sql from 'mssql';

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const CACHE_HARD_MAX_MS = 24 * 60 * 60 * 1000;

// ARION Trend report keys — v11.0 SIX-REPORT model (Brandon, 2026-07-24).
// Three CHANNEL reports + three QUALITY reports. Must stay in lockstep with
// ARION_TREND_REPORTS in Portal-mybrand/src/arion/analytics/trendEngines.ts.
//
// `presence` is DELIBERATELY ABSENT. It was the weighted composite of the
// other reports AND was also stored as a report row, so this average
// double-counted it against its own components — the "math that doesn't
// reconcile" behind the 2026-06-28 insights gate. Migration 045 removes the
// historical rows. Do not add it back.
const ARION_TREND_REPORT_KEYS = [
  'search_visibility', 'local_presence', 'social_presence',
  'audience_conversion', 'content', 'technical',
];

// ARION Intelligence report keys — 6 single-source reports (locked
// 2026-06-21 by Brandon). Matches arion.intelligence_cache rows seeded
// by the 6 calculators under lib/intelligence/. NO cross-platform keys
// (the prior lead_source_quality, content_roi, reputation_revenue were
// relocated to ARGUS Cross-Platform Intelligence and are soft-deleted
// from the cache via the relocated_to column).
const ARION_INTEL_REPORT_KEYS = [
  'seo_authority',
  'visibility_trajectory',
  'competitive_presence',
  'crawl_depth',
  'schema_coverage',
  'pagespeed_distribution',
];

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Compute ARION's Trend Score from the latest period per report_key.
 * Returns a 0-100 average across present reports, or null if no data.
 */
async function computeTrendComponent(pool, tenantId) {
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        ;WITH latest AS (
          SELECT report_key, score,
                 ROW_NUMBER() OVER (PARTITION BY report_key ORDER BY period_end DESC) AS rn
          FROM arion.ia_insights_score_history
          WHERE tenant_id = @tenantId
            AND report_key IN (${ARION_TREND_REPORT_KEYS.map(k => `'${k}'`).join(',')})
        )
        SELECT report_key, score FROM latest WHERE rn = 1
      `);
    const rows = r.recordset || [];
    if (rows.length === 0) return null;
    const sum = rows.reduce((a, b) => a + Number(b.score), 0);
    return round1(sum / rows.length);
  } catch (err) {
    console.warn('[arion/platformPulse] trend component failed:', err.message);
    return null;
  }
}

/**
 * Compute ARION's Intelligence Score from cached intelligence reports.
 * Averages whichever of the 6 reports have a non-null score.
 */
async function computeIntelligenceComponent(pool, tenantId) {
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT report_key, AVG(CAST(score AS DECIMAL(10,2))) AS score
        FROM arion.intelligence_cache
        WHERE tenant_id = @tenantId
          AND report_key IN (${ARION_INTEL_REPORT_KEYS.map(k => `'${k}'`).join(',')})
          AND score IS NOT NULL
          AND relocated_to IS NULL
        GROUP BY report_key
      `);
    const rows = r.recordset || [];
    if (rows.length === 0) return null;
    const sum = rows.reduce((a, b) => a + Number(b.score), 0);
    return round1(sum / rows.length);
  } catch (err) {
    console.warn('[arion/platformPulse] intelligence component failed:', err.message);
    return null;
  }
}

/**
 * Combine trend + intelligence into a single Platform Pulse value.
 * Returns { score, trend_component, intelligence_component, partial, no_data }.
 */
export function combineComponents(trend, intel) {
  const hasT = trend != null && isFinite(trend);
  const hasI = intel != null && isFinite(intel);
  if (hasT && hasI) {
    return {
      score: round1((trend + intel) / 2),
      trend_component: round1(trend),
      intelligence_component: round1(intel),
      partial: false,
      no_data: false,
    };
  }
  if (hasT && !hasI) {
    return {
      score: round1(trend),
      trend_component: round1(trend),
      intelligence_component: null,
      partial: true,
      no_data: false,
    };
  }
  if (!hasT && hasI) {
    return {
      score: round1(intel),
      trend_component: null,
      intelligence_component: round1(intel),
      partial: true,
      no_data: false,
    };
  }
  return {
    score: null,
    trend_component: null,
    intelligence_component: null,
    partial: false,
    no_data: true,
  };
}

/**
 * Compute ARION Platform Pulse from scratch (no cache read).
 * Returns the cache row shape: { score, trend_component, intelligence_component, partial, no_data }.
 */
export async function computeArionPlatformPulse(pool, tenantId) {
  const [trend, intel] = await Promise.all([
    computeTrendComponent(pool, tenantId),
    computeIntelligenceComponent(pool, tenantId),
  ]);
  return combineComponents(trend, intel);
}

/**
 * Read the cached Platform Pulse row. Returns null if missing or table absent.
 */
export async function readCache(pool, tenantId) {
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 tenant_id, score, trend_component, intelligence_component,
               partial, no_data, calculated_at
        FROM arion.platform_pulse_cache
        WHERE tenant_id = @tenantId
      `);
    return r.recordset[0] || null;
  } catch {
    // Table missing on a fresh deploy — treat as miss.
    return null;
  }
}

/**
 * Upsert the cache row.
 */
export async function writeCache(pool, tenantId, computed) {
  try {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('score', sql.Decimal(5, 2), computed.score)
      .input('trendC', sql.Decimal(5, 2), computed.trend_component)
      .input('intelC', sql.Decimal(5, 2), computed.intelligence_component)
      .input('partial', sql.Bit, computed.partial ? 1 : 0)
      .input('noData', sql.Bit, computed.no_data ? 1 : 0)
      .query(`
        MERGE arion.platform_pulse_cache AS tgt
        USING (SELECT @tenantId AS tenant_id) AS src
          ON tgt.tenant_id = src.tenant_id
        WHEN MATCHED THEN UPDATE SET
          score = @score,
          trend_component = @trendC,
          intelligence_component = @intelC,
          partial = @partial,
          no_data = @noData,
          calculated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (tenant_id, score, trend_component, intelligence_component, partial, no_data, calculated_at)
          VALUES (@tenantId, @score, @trendC, @intelC, @partial, @noData, SYSDATETIMEOFFSET());
      `);
  } catch (err) {
    console.warn('[arion/platformPulse] cache write failed:', err.message);
  }
}

/**
 * Top-level: read cache, recompute if stale (>6h), write back, return result.
 * If refresh=true, always recomputes.
 */
export async function getArionPlatformPulse(pool, tenantId, { refresh = false } = {}) {
  const cached = await readCache(pool, tenantId);
  const now = Date.now();
  const ageMs = cached ? (now - new Date(cached.calculated_at).getTime()) : Infinity;

  if (!refresh && cached && ageMs < CACHE_TTL_MS) {
    return {
      ...cached,
      score: cached.score == null ? null : Number(cached.score),
      trend_component: cached.trend_component == null ? null : Number(cached.trend_component),
      intelligence_component: cached.intelligence_component == null ? null : Number(cached.intelligence_component),
      partial: Boolean(cached.partial),
      no_data: Boolean(cached.no_data),
      cache_state: 'fresh',
    };
  }

  const computed = await computeArionPlatformPulse(pool, tenantId);
  await writeCache(pool, tenantId, computed);
  return { ...computed, calculated_at: new Date().toISOString(), cache_state: cached ? 'expired_recomputed' : 'miss' };
}

export const __internals = {
  ARION_TREND_REPORT_KEYS,
  ARION_INTEL_REPORT_KEYS,
  combineComponents,
};
