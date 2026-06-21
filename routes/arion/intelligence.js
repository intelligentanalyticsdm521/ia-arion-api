// routes/arion/intelligence.js — ARION Intelligence aggregator endpoint.
//
// Brandon's locked architecture (2026-06-21):
//   Each ARION Intelligence report is SINGLE-SOURCE. No SPARK/OLIVER/GBP
//   blends. Cross-channel intelligence lives in ARGUS.
//
// GET /arion/sites/:siteId/intelligence
//   Returns: { intelligenceScore, intelligenceTier, reports:{...}, ... }
//
// POST /arion/sites/:siteId/intelligence/refresh
//   Force-recalc + cache write. Returns same shape as GET.
//
// Caches via arion.intelligence_cache with a 12-hour TTL. Soft-deleted
// rows (relocated_to IS NOT NULL) are excluded from reads — kept for
// audit trail of the cross-platform → ARGUS relocation.

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getSearchConsoleDates } from '../../lib/googleServices.js';
import { plugin as pluginApi } from '../../lib/pluginClient.js';
import { runAllArionIntelligence, ARION_INTEL_REPORTS } from '../../lib/intelligence/index.js';
import { CACHE_TTL_MS } from '../../lib/intelligence/utils.js';

const router = Router({ mergeParams: true });

// ─── helper: pull the site row scoped to the tenant ─────────────────────
async function getSiteForTenant(pool, tenantId, siteId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query('SELECT * FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
  return r.recordset[0] || null;
}

// ─── helper: gather all the single-source data the calculators need ─────
async function buildIntelContext({ site, tenantId }) {
  const seRankingProjectId = site?.se_ranking_project_id || null;
  const seRankingAuditId = site?.se_ranking_audit_id || null;
  const tier = (site?.seo_addon_tier || '').toLowerCase() || 'starter';

  // GSC dates — only fetched when the site has a GSC oauth refresh token
  // available. Returns array of { date, clicks, impressions, ctr, position }
  // over the last 90 days. Each calculator individually handles missing
  // data, so a null is safe.
  let gscDates = [];
  try {
    const refreshToken = site?.gbp_oauth_token_ref;  // same OAuth token serves GSC + GBP per arion.js convention
    if (refreshToken && site?.domain) {
      const siteUrl = 'https://' + site.domain;
      const gscRows = await getSearchConsoleDates(refreshToken, siteUrl, 90).catch(() => []);
      gscDates = Array.isArray(gscRows) ? gscRows : [];
    }
  } catch (_) {
    gscDates = [];
  }

  // Plugin SEO aggregate — only when the IA Plugin is reachable.
  let pluginSeoAgg = null;
  let totalPages = null;
  try {
    if (site?.domain) {
      const seo = await pluginApi.contentSeoAgg(site).catch(() => null);
      if (seo?.ok && seo.data) {
        pluginSeoAgg = seo.data;
        totalPages = Number(seo.data?.summary?.totalPosts || seo.data?.totals?.posts || 0) || null;
      }
    }
  } catch (_) {
    pluginSeoAgg = null;
  }

  // PageSpeed snapshots — read from arion.site_pagespeed_snapshot.
  let pageSpeedSnapshots = [];
  try {
    const pool = await getServicesPool();
    const psiRes = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .query(`
        SELECT TOP 60 strategy, performance_score, lcp_ms, inp_ms, cls_score,
                      fcp_ms, tbt_ms, run_date
          FROM arion.site_pagespeed_snapshot
         WHERE tenant_id = @tenantId AND site_id = @siteId
         ORDER BY run_date DESC, id DESC
      `);
    pageSpeedSnapshots = psiRes.recordset || [];
  } catch (_) {
    pageSpeedSnapshots = [];
  }

  return {
    tier,
    tenantId,
    seRankingProjectId,
    seRankingAuditId,
    gscDates,
    pluginSeoAgg,
    totalPages,
    pageSpeedSnapshots,
  };
}

// ─── helper: write a calculator result into arion.intelligence_cache ────
async function writeCache(pool, { tenantId, siteId, reportKey, payload }) {
  const score = Number.isFinite(payload?.score) ? payload.score : null;
  const tier = payload?.tier || null;
  const payloadJson = JSON.stringify(payload || {});
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  try {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('reportKey', sql.NVarChar(40), reportKey)
      .input('score', sql.Int, score)
      .input('tierGrade', sql.NVarChar(2), tier)
      .input('payloadJson', sql.NVarChar(sql.MAX), payloadJson)
      .input('expiresAt', sql.DateTime2, expiresAt)
      .query(`
        MERGE arion.intelligence_cache AS tgt
        USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @reportKey AS report_key) AS src
          ON tgt.tenant_id = src.tenant_id AND tgt.site_id = src.site_id AND tgt.report_key = src.report_key
        WHEN MATCHED THEN UPDATE SET
          score = @score,
          tier_grade = @tierGrade,
          payload_json = @payloadJson,
          last_calculated_at = SYSUTCDATETIME(),
          expires_at = @expiresAt,
          relocated_to = NULL,  -- if a fresh write lands, clear any prior relocate flag
          updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (tenant_id, site_id, report_key, score, tier_grade, payload_json, last_calculated_at, expires_at)
        VALUES
          (@tenantId, @siteId, @reportKey, @score, @tierGrade, @payloadJson, SYSUTCDATETIME(), @expiresAt);
      `);
  } catch (err) {
    console.error(`[intelligence/cache:write] report=${reportKey} err=${err.message}`);
  }
}

// ─── helper: read all (non-relocated) cached reports for a site ─────────
async function readCache(pool, { tenantId, siteId }) {
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT report_key, score, tier_grade, payload_json, last_calculated_at, expires_at
          FROM arion.intelligence_cache
         WHERE tenant_id = @tenantId AND site_id = @siteId
           AND relocated_to IS NULL
      `);
    const out = {};
    for (const row of r.recordset || []) {
      try {
        out[row.report_key] = {
          ...JSON.parse(row.payload_json || '{}'),
          cached: true,
          cached_at: row.last_calculated_at,
          expires_at: row.expires_at,
        };
      } catch (_) {
        // skip bad payload
      }
    }
    return out;
  } catch (err) {
    console.error('[intelligence/cache:read]', err.message);
    return {};
  }
}

// ─── GET /arion/sites/:siteId/intelligence ─────────────────────────────
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    // Serve cache if all 6 reports are present + non-expired.
    const cached = await readCache(pool, { tenantId, siteId });
    const allFresh = ARION_INTEL_REPORTS.every((k) => {
      const entry = cached[k];
      if (!entry) return false;
      if (!entry.expires_at) return false;
      return new Date(entry.expires_at).getTime() > Date.now();
    });

    if (allFresh) {
      const reports = cached;
      const numericScores = ARION_INTEL_REPORTS
        .map((k) => reports[k]?.score)
        .filter((s) => typeof s === 'number' && Number.isFinite(s));
      const intelligenceScore = numericScores.length > 0
        ? Math.round(numericScores.reduce((s, n) => s + n, 0) / numericScores.length)
        : null;
      const tierGrade = intelligenceScore == null ? null
        : intelligenceScore >= 80 ? 'A'
        : intelligenceScore >= 65 ? 'B'
        : intelligenceScore >= 45 ? 'C' : 'D';
      return res.json({
        data: {
          surface: 'arion',
          reports,
          intelligenceScore,
          intelligenceTier: tierGrade,
          activeReports: numericScores.length,
          totalReports: ARION_INTEL_REPORTS.length,
          tier: (site.seo_addon_tier || '').toLowerCase() || null,
          calculated_at: new Date().toISOString(),
          source: 'cache',
        },
      });
    }

    // Cache miss/stale — recompute, store, return.
    const ctx = await buildIntelContext({ site, tenantId });
    const result = await runAllArionIntelligence(ctx);

    // Fire-and-forget cache writes — don't block the response.
    Promise.all(
      ARION_INTEL_REPORTS.map((key) =>
        writeCache(pool, { tenantId, siteId, reportKey: key, payload: result.reports[key] })
      ),
    ).catch((err) => console.error('[intelligence:cache batch]', err.message));

    return res.json({ data: { ...result, source: 'fresh' } });
  } catch (err) {
    console.error('[arion/intelligence:GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ─── POST /arion/sites/:siteId/intelligence/refresh ────────────────────
router.post('/refresh', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const ctx = await buildIntelContext({ site, tenantId });
    const result = await runAllArionIntelligence(ctx);

    // Sync writes — caller wants confirmation.
    for (const key of ARION_INTEL_REPORTS) {
      await writeCache(pool, { tenantId, siteId, reportKey: key, payload: result.reports[key] });
    }

    return res.json({ data: { ...result, source: 'fresh', forced: true } });
  } catch (err) {
    console.error('[arion/intelligence:refresh]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
