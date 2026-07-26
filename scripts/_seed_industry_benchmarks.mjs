#!/usr/bin/env node
/**
 * PROD DATA — industry benchmark seed (Brandon 2026-07-26: "do the research
 * to get industry markers" at high / medium / detail tiers).
 *
 * 1. Applies migration 047 (tier/source/as_of/p75 columns — additive).
 * 2. Seeds researched benchmark rows (every row carries source + as_of;
 *    values are published-industry p50s from the 2026-07-26 research pass —
 *    see INSIGHTS_MASTER_ANALYTICS_BLUEPRINT.md §5).
 *    Tiers: high (service_industry) · medium (vertical) · model (scoring
 *    constants, e.g. expected CTR by SERP position). DETAIL tier is
 *    deliberately NOT fabricated — it gets computed from our own SE Ranking
 *    competitor + CrUX pulls in Ingestion Phase 2.
 * 3. Maps the four tenants to categories in core.tenant_settings (probing
 *    the table shape first; skips gracefully if unexpected).
 *
 * Metric keys are CATALOG keys only — never invent keys the catalogs don't
 * score. MERGE-idempotent on (service_category, metric_key).
 *
 * Run from C:\dev\iadm\arion-api:  node scripts/_seed_industry_benchmarks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const AS_OF = '2026-07-26';

// source shorthands
const SRC = {
  email: 'WebFX/Klaviyo/Brevo email benchmarks 2026',
  ga4: 'Databox GA4 industry benchmarks 2025; circle S studio AEC engagement 2025',
  reviews: 'BrightLocal Local Consumer Review Survey 2025',
  gbp: 'WebFX GBP benchmarks 2026; Gitnux GBP statistics',
  dental: 'DentalMarketingGuy CRO 2026; 2740 Consulting dental stats 2025; Q3-2025 dental PPC benchmarks',
  homesvc: 'ServiceTitan Home Services Benchmark Report 2025; HomeAdvisor/Angi 2025-26 cost guides',
  dso: 'CreditPulse DSO by industry 2025; Hackett Working Capital Survey 2025',
  cwv: 'Google Core Web Vitals "good" thresholds',
  psi: 'CrUX/HTTPArchive mobile performance distributions (approx. medians)',
  ctr: 'FirstPageSage / GrowthSRC organic CTR studies 2025-26 (AI-Overview-adjusted, conservative)',
};

// (tier, category, metric_key, value, p75, units, source, notes)
const ROWS = [
  // ── HIGH TIER: default (all industries) ─────────────────────────────────
  ['high', 'default', 'open_rate', 19.2, 25, 'percent', SRC.email, 'All-industry avg open rate; p75 = strong. Apple MPP inflates — treat directionally.'],
  ['high', 'default', 'click_rate', 2.4, 3.5, 'percent', SRC.email, 'All-industry avg CTR'],
  ['high', 'default', 'click_to_open', 12, 16, 'percent', SRC.email, 'Derived CTOR norm'],
  ['high', 'default', 'unsub_rate', 0.3, 0.15, 'percent', SRC.email, 'Lower is better; p75 col holds the STRONG (lower) value'],
  ['high', 'default', 'bounce_rate', 2.5, 1.5, 'percent', SRC.email, 'Email bounce; lower better'],
  ['high', 'default', 'delivery_rate', 97.5, 99, 'percent', SRC.email, ''],
  ['high', 'default', 'ga_engagement_rate', 50, 58, 'percent', SRC.ga4, 'Healthy 45-55 for local/professional sites'],
  ['high', 'default', 'ga_bounce_rate', 50, 42, 'percent', SRC.ga4, 'Lower better; p75 = strong'],
  ['high', 'default', 'ga_avg_duration', 158, 210, 'seconds', SRC.ga4, 'Median engagement time ~2m38s'],
  ['high', 'default', 'ga_mobile_share', 60, 60, 'percent', SRC.ga4, 'Anchor, not a target'],
  ['high', 'default', 'gbp_rating', 4.5, 4.7, 'stars', SRC.reviews, '38% of consumers require 4+ to trust; 4.5 competitive floor'],
  ['high', 'default', 'gbp_review_count', 40, 100, 'reviews', SRC.reviews, '59% want 20-99 reviews to trust the rating'],
  ['high', 'default', 'gbp_review_velocity', 4, 8, 'reviews/mo', SRC.reviews, 'Freshness signal'],
  ['high', 'default', 'gbp_response_rate', 75, 90, 'percent', SRC.reviews, ''],
  ['high', 'default', 'gbp_action_rate', 15, 25, 'percent', SRC.gbp, 'Actions/impressions; GBP sources conflict (5-45%) — conservative mid'],
  ['high', 'default', 'psi_mobile_perf', 60, 75, 'score', SRC.psi, ''],
  ['high', 'default', 'psi_desktop_perf', 80, 90, 'score', SRC.psi, ''],
  ['high', 'default', 'psi_accessibility', 85, 95, 'score', SRC.psi, ''],
  ['high', 'default', 'psi_seo', 85, 95, 'score', SRC.psi, ''],
  ['high', 'default', 'psi_best_practices', 90, 100, 'score', SRC.psi, ''],
  ['high', 'default', 'lcp_ms', 2500, 2000, 'ms', SRC.cwv, 'Google "good" threshold; lower better'],
  ['high', 'default', 'inp_ms', 200, 150, 'ms', SRC.cwv, 'Lower better'],
  ['high', 'default', 'cls', 0.1, 0.05, 'score', SRC.cwv, 'Lower better'],
  ['high', 'default', 'cwv_pass', 75, 90, 'percent', SRC.cwv, ''],
  ['high', 'default', 'avg_days_to_pay', 45, 30, 'days', SRC.dso, 'Good = within ~15 days of net-30; B2B median 56'],
  ['high', 'default', 'on_time_rate', 90, 95, 'percent', SRC.homesvc, ''],
  ['high', 'default', 'ga_conversion_rate', 2.5, 5, 'percent', SRC.ga4, 'Visit → contact action (tel/form/mailto)'],

  // ── HIGH TIER: service industries ───────────────────────────────────────
  ['high', 'home_services', 'ga_conversion_rate', 2.0, 4, 'percent', SRC.homesvc, 'Visit-to-contact for home services'],
  ['high', 'home_services', 'ga_mobile_share', 65, 65, 'percent', SRC.ga4, ''],
  ['high', 'home_services', 'avg_days_to_pay', 30, 20, 'days', SRC.dso, 'Consumer-paid trades collect faster than B2B'],
  ['high', 'medical_practice', 'ga_conversion_rate', 3.5, 8, 'percent', SRC.dental, 'Practice sites convert 3-5%; top 8-15%'],
  ['high', 'medical_practice', 'gbp_rating', 4.6, 4.8, 'stars', SRC.dental, '31% require 4.5+ minimum to contact a practice'],
  ['high', 'medical_practice', 'ga_engagement_rate', 55, 62, 'percent', SRC.ga4, ''],
  ['high', 'professional_services', 'ga_engagement_rate', 50, 58, 'percent', SRC.ga4, 'AEC/professional 45-55'],
  ['high', 'professional_services', 'ga_avg_duration', 180, 240, 'seconds', SRC.ga4, 'Research-mode browsing'],
  ['high', 'professional_services', 'open_rate', 21, 27, 'percent', SRC.email, 'B2B services'],
  ['high', 'professional_services', 'avg_days_to_pay', 45, 32, 'days', SRC.dso, ''],
  ['high', 'agriculture', 'open_rate', 22, 28, 'percent', SRC.email, 'Agriculture email engagement runs above retail'],
  ['high', 'agriculture', 'ga_avg_duration', 150, 200, 'seconds', SRC.ga4, ''],
  ['high', 'agriculture', 'avg_days_to_pay', 50, 35, 'days', SRC.dso, 'Seasonal settlement patterns'],

  // ── MEDIUM TIER: verticals (current clients + adjacent prospects) ───────
  ['medium', 'dental_practice', 'ga_conversion_rate', 4.0, 9, 'percent', SRC.dental, 'Avg dental site 3-5%; optimized 8-15%'],
  ['medium', 'dental_practice', 'gbp_rating', 4.6, 4.8, 'stars', SRC.dental, ''],
  ['medium', 'dental_practice', 'gbp_review_count', 60, 150, 'reviews', SRC.reviews, ''],
  ['medium', 'dental_practice', 'gbp_review_velocity', 5, 10, 'reviews/mo', SRC.dental, ''],
  ['medium', 'dental_practice', 'open_rate', 21, 26, 'percent', SRC.email, 'Healthcare segment'],
  ['medium', 'dental_practice', 'ga_engagement_rate', 55, 62, 'percent', SRC.ga4, ''],
  ['medium', 'lawn_landscape', 'ga_conversion_rate', 2.0, 4, 'percent', SRC.homesvc, ''],
  ['medium', 'lawn_landscape', 'avg_invoice', 300, 500, 'usd', SRC.homesvc, 'Bundle-style lawn spend $100-500; approx.'],
  ['medium', 'snow_removal', 'avg_invoice', 350, 600, 'usd', SRC.homesvc, 'Seasonal contracts vary widely; approx.'],
  ['medium', 'pressure_washing', 'avg_invoice', 300, 550, 'usd', SRC.homesvc, 'Approx. residential job range'],
  ['medium', 'junk_removal', 'avg_invoice', 400, 600, 'usd', SRC.homesvc, 'Typical $150-600 residential; approx.'],
  ['medium', 'junk_removal', 'ga_conversion_rate', 2.5, 5, 'percent', SRC.homesvc, 'High-intent urgent service'],
  ['medium', 'hvac', 'ga_conversion_rate', 2.5, 5, 'percent', SRC.homesvc, 'Prospect vertical'],
  ['medium', 'plumbing', 'ga_conversion_rate', 2.5, 5, 'percent', SRC.homesvc, 'Prospect vertical'],
  ['medium', 'roofing', 'ga_conversion_rate', 2.0, 4, 'percent', SRC.homesvc, 'Prospect vertical'],
  ['medium', 'software_agency', 'open_rate', 21, 27, 'percent', SRC.email, ''],
  ['medium', 'software_agency', 'click_rate', 2.5, 3.8, 'percent', SRC.email, ''],
  ['medium', 'software_agency', 'ga_engagement_rate', 52, 60, 'percent', SRC.ga4, ''],
  ['medium', 'software_agency', 'ga_avg_duration', 180, 240, 'seconds', SRC.ga4, ''],
  ['medium', 'software_agency', 'ga_conversion_rate', 2.5, 5, 'percent', SRC.ga4, ''],
  ['medium', 'software_agency', 'avg_days_to_pay', 45, 32, 'days', SRC.dso, ''],
  ['medium', 'ag_services', 'open_rate', 22, 28, 'percent', SRC.email, ''],
  ['medium', 'ag_services', 'ga_bounce_rate', 50, 42, 'percent', SRC.ga4, ''],
  ['medium', 'ag_services', 'avg_days_to_pay', 50, 35, 'days', SRC.dso, ''],

  // ── MODEL TIER: scoring-model constants ─────────────────────────────────
  ['model', 'default', 'serp_ctr_p1', 22, null, 'percent', SRC.ctr, 'Organic CTR pos 1, AI-Overview-adjusted conservative blend'],
  ['model', 'default', 'serp_ctr_p2', 12, null, 'percent', SRC.ctr, ''],
  ['model', 'default', 'serp_ctr_p3', 8, null, 'percent', SRC.ctr, ''],
  ['model', 'default', 'serp_ctr_p5', 5, null, 'percent', SRC.ctr, ''],
  ['model', 'default', 'serp_ctr_p10', 1.7, null, 'percent', SRC.ctr, ''],
];

// Tenant → category mapping (medium tier; ladder resolves medium→high→default)
const TENANT_CATEGORIES = [
  { tenantId: '8C9527B9-8999-4B31-A306-F3D4CCC39FBD', name: 'Intelligent Analytics', category: 'software_agency' },
  // Verified from their SE Ranking keyword set 2026-07-26: pressure/soft
  // washing + snow removal (Des Moines). Primary category pressure_washing.
  { tenantId: '12839687-67FA-4144-A152-1219D1A64901', name: 'Rolling In It', category: 'pressure_washing' },
  { tenantId: '45E93346-DBA9-48D5-802B-A4E09A1B03A9', name: 'Briarwood Dental', category: 'dental_practice' },
  { tenantId: '777C1093-F725-424B-8293-E6881190C40C', name: 'Midwest Ag Services', category: 'ag_services' },
];

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true }, requestTimeout: 60000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

try {
  // 1. migration 047
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const mig = fs.readFileSync(path.join(__dir, '..', 'db', 'migrations', '047_benchmark_tiers.sql'), 'utf8');
  for (const b of mig.split(/^\s*GO\s*$/mi)) if (b.trim()) await pool.request().batch(b.trim());
  console.log('[047] applied');

  // 2. seed rows (MERGE by category+metric)
  let upserted = 0;
  for (const [tier, cat, key, val, p75, units, source, notes] of ROWS) {
    const r = await pool.request()
      .input('tier', sql.NVarChar(20), tier)
      .input('cat', sql.NVarChar(100), cat)
      .input('key', sql.NVarChar(100), key)
      .input('val', sql.Float, val)
      .input('p75', sql.Float, p75)
      .input('units', sql.NVarChar(50), units)
      .input('src', sql.NVarChar(300), source)
      .input('asof', sql.Date, AS_OF)
      .input('notes', sql.NVarChar(500), notes || null)
      .query(`
        MERGE arion.ia_insights_benchmark AS tgt
        USING (SELECT @cat c, @key k) AS src ON tgt.service_category = src.c AND tgt.metric_key = src.k
        WHEN MATCHED THEN UPDATE SET benchmark_value=@val, p75_value=@p75, units=@units, tier=@tier,
          source=@src, as_of=@asof, notes=@notes, updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (service_category, metric_key, benchmark_value, p75_value, units, tier, source, as_of, notes, updated_at)
          VALUES (@cat, @key, @val, @p75, @units, @tier, @src, @asof, @notes, SYSUTCDATETIME());`);
    upserted += r.rowsAffected.reduce((a, b) => a + b, 0);
  }
  console.log(`[seed] ${upserted} benchmark row(s) upserted (${ROWS.length} defined)`);

  // 3. tenant categories — the settings table is lumen.tenant_settings
  // (the /api/v1/tenant-settings route's store; tenant_id is NVARCHAR there).
  const cols = (await pool.request().query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='tenant_settings'`)).recordset.map((r) => r.COLUMN_NAME);
  console.log('[tenant_settings] columns:', cols.join(', ') || '(table missing)');
  const need = ['tenant_id', 'setting_key', 'setting_value'];
  if (need.every((c) => cols.includes(c))) {
    for (const t of TENANT_CATEGORIES) {
      await pool.request()
        .input('tid', sql.NVarChar(100), t.tenantId.toLowerCase())
        .input('val', sql.NVarChar(200), t.category)
        .query(`
          MERGE lumen.tenant_settings AS tgt
          USING (SELECT @tid tid) s ON tgt.tenant_id = s.tid AND tgt.setting_key = 'service_category'
          WHEN MATCHED THEN UPDATE SET setting_value = @val, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (tenant_id, setting_key, setting_value, updated_at) VALUES (@tid, 'service_category', @val, SYSUTCDATETIME());`);
      console.log(`[category] ${t.name} → ${t.category}`);
    }
  } else {
    console.log('[category] lumen.tenant_settings shape unexpected — SKIPPED tenant mapping (reader will use default tier)');
  }

  const v = await pool.request().query(`
    SELECT tier, COUNT(*) n FROM arion.ia_insights_benchmark GROUP BY tier ORDER BY tier`);
  console.table(v.recordset);
} finally {
  await pool.close();
}
