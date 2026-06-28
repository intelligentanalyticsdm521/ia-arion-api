/**
 * One-off — force-recompute ARION Intelligence for tenant
 *   8C9527B9-8999-4B31-A306-F3D4CCC39FBD
 * Mirrors POST /arion/sites/:siteId/intelligence/refresh but bypasses HTTP auth
 * by importing the calculator + DB pool directly.
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { runAllArionIntelligence, ARION_INTEL_REPORTS } from "../lib/intelligence/index.js";
import { getSearchConsoleDates } from "../lib/googleServices.js";
import { plugin as pluginApi } from "../lib/pluginClient.js";
import { CACHE_TTL_MS } from "../lib/intelligence/utils.js";

const TENANT_ID = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net",
  database: process.env.SQL_DATABASE || "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log("\n========== ARION Intelligence Recompute ==========");
console.log("Tenant:", TENANT_ID);

// 1. Find the site row(s)
const siteRows = await pool.request()
  .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
  .query("SELECT * FROM arion.site WHERE tenant_id = @tenantId");
const sites = siteRows.recordset || [];
console.log(`\nSites found: ${sites.length}`);
for (const s of sites) {
  console.log(`  site_id=${s.site_id} domain=${s.domain} tier=${s.seo_addon_tier} se_proj=${s.se_ranking_project_id} se_audit=${s.se_ranking_audit_id}`);
}

if (sites.length === 0) {
  console.log("No sites — exit.");
  process.exit(0);
}

// 2. For each site, BEFORE state of intelligence_cache
console.log("\n----- BEFORE recompute (cache state) -----");
for (const s of sites) {
  const c = await pool.request()
    .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
    .input("siteId", sql.UniqueIdentifier, s.site_id)
    .query(`SELECT report_key, score, tier_grade, state = JSON_VALUE(payload_json,'$.state'),
                   last_calculated_at, expires_at
              FROM arion.intelligence_cache
             WHERE tenant_id=@tenantId AND site_id=@siteId AND relocated_to IS NULL`);
  console.log(`  site=${s.site_id}: ${c.recordset.length} cache rows`);
  for (const r of c.recordset) {
    console.log(`    ${r.report_key.padEnd(28)} score=${String(r.score).padEnd(6)} state=${r.state} expires=${r.expires_at?.toISOString?.() || r.expires_at}`);
  }
}

// 3. Build context + run + write cache for each site
for (const site of sites) {
  console.log(`\n----- Recomputing site=${site.site_id} (${site.domain}) -----`);
  const tier = (site?.seo_addon_tier || '').toLowerCase() || 'starter';
  let gscDates = [];
  try {
    const refreshToken = site?.gsc_oauth_token_ref || site?.gbp_oauth_token_ref || null;
    const siteUrl = site?.gsc_site_url || (site?.domain ? 'https://' + site.domain : null);
    if (refreshToken && siteUrl) {
      const rows = await getSearchConsoleDates(refreshToken, siteUrl, 90).catch((err) => {
        console.error("[gsc-fetch]", err?.message || err);
        return [];
      });
      gscDates = Array.isArray(rows) ? rows : [];
    } else {
      console.log(`  GSC: skipped (refreshToken=${!!refreshToken} siteUrl=${siteUrl})`);
    }
  } catch (e) { console.error("[gsc-block]", e.message); }
  console.log(`  GSC days: ${gscDates.length}`);

  let pluginSeoAgg = null;
  let totalPages = null;
  try {
    if (site?.domain) {
      const seo = await pluginApi.contentSeoAgg(site).catch((err) => {
        console.error("[plugin-fetch]", err?.message || err);
        return null;
      });
      if (seo?.ok && seo.data) {
        pluginSeoAgg = seo.data;
        totalPages = Number(seo.data?.summary?.totalPosts || seo.data?.totals?.posts || 0) || null;
      }
    }
  } catch (e) { console.error("[plugin-block]", e.message); }
  console.log(`  Plugin SEO agg: ${pluginSeoAgg ? 'present' : 'null'} totalPages=${totalPages}`);

  let pageSpeedSnapshots = [];
  try {
    const psiRes = await pool.request()
      .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
      .input("siteId", sql.UniqueIdentifier, site.site_id)
      .query(`SELECT TOP 60 strategy, performance_score, lcp_ms, inp_ms, cls_score,
                            fcp_ms, tbt_ms, run_date
                FROM arion.site_pagespeed_snapshot
               WHERE tenant_id=@tenantId AND site_id=@siteId
               ORDER BY run_date DESC, snapshot_id DESC`);
    pageSpeedSnapshots = psiRes.recordset || [];
  } catch (e) { console.error("[psi-block]", e.message); }
  console.log(`  PSI snapshots: ${pageSpeedSnapshots.length}`);

  const ctx = {
    tier,
    tenantId: TENANT_ID,
    seRankingProjectId: site?.se_ranking_project_id || null,
    seRankingAuditId: site?.se_ranking_audit_id || null,
    gscDates,
    pluginSeoAgg,
    totalPages,
    pageSpeedSnapshots,
    dataSources: {
      gscDays: gscDates.length,
      pluginAgg: pluginSeoAgg != null,
      psiSnapshots: pageSpeedSnapshots.length,
      seRankingProject: site?.se_ranking_project_id || null,
      seRankingAudit: site?.se_ranking_audit_id || null,
    },
  };

  console.log("  Running calculators…");
  const result = await runAllArionIntelligence(ctx);

  console.log(`  Result: intelligenceScore=${result.intelligenceScore} tier=${result.intelligenceTier} active=${result.activeReports}/${result.totalReports}`);
  for (const key of ARION_INTEL_REPORTS) {
    const r = result.reports[key];
    console.log(`    ${key.padEnd(28)} score=${String(r?.score).padEnd(6)} tier=${r?.tier} state=${r?.state}`);
  }

  // Write cache (mirrors writeCache in routes/arion/intelligence.js)
  for (const key of ARION_INTEL_REPORTS) {
    const payload = result.reports[key];
    const score = Number.isFinite(payload?.score) ? payload.score : null;
    const ttierGrade = payload?.tier || null;
    const ttlMs = payload?.state === 'insufficient_data' ? 60 * 60 * 1000 : CACHE_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);
    try {
      await pool.request()
        .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
        .input("siteId", sql.UniqueIdentifier, site.site_id)
        .input("reportKey", sql.NVarChar(40), key)
        .input("score", sql.Int, score)
        .input("tierGrade", sql.NVarChar(2), ttierGrade)
        .input("payloadJson", sql.NVarChar(sql.MAX), JSON.stringify(payload || {}))
        .input("expiresAt", sql.DateTime2, expiresAt)
        .query(`
MERGE arion.intelligence_cache AS tgt
USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @reportKey AS report_key) AS src
  ON tgt.tenant_id = src.tenant_id AND tgt.site_id = src.site_id AND tgt.report_key = src.report_key
WHEN MATCHED THEN UPDATE SET
  score = @score, tier_grade = @tierGrade, payload_json = @payloadJson,
  last_calculated_at = SYSUTCDATETIME(), expires_at = @expiresAt,
  relocated_to = NULL, updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (tenant_id, site_id, report_key, score, tier_grade, payload_json, last_calculated_at, expires_at)
VALUES (@tenantId, @siteId, @reportKey, @score, @tierGrade, @payloadJson, SYSUTCDATETIME(), @expiresAt);
        `);
    } catch (e) { console.error(`[cache-write ${key}]`, e.message); }
  }
}

// 4. AFTER state
console.log("\n----- AFTER recompute (cache state) -----");
const summary = { has_score: [], still_null: [] };
for (const s of sites) {
  const c = await pool.request()
    .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
    .input("siteId", sql.UniqueIdentifier, s.site_id)
    .query(`SELECT report_key, score, tier_grade, JSON_VALUE(payload_json,'$.state') AS state,
                   last_calculated_at, expires_at
              FROM arion.intelligence_cache
             WHERE tenant_id=@tenantId AND site_id=@siteId AND relocated_to IS NULL
             ORDER BY report_key`);
  console.log(`  site=${s.site_id}: ${c.recordset.length} cache rows`);
  for (const r of c.recordset) {
    console.log(`    ${r.report_key.padEnd(28)} score=${String(r.score).padEnd(6)} state=${r.state}`);
    if (r.score != null) summary.has_score.push(r.report_key);
    else summary.still_null.push(r.report_key);
  }
}

console.log("\n========== Summary ==========");
console.log(JSON.stringify(summary, null, 2));

await pool.close();
process.exit(0);
