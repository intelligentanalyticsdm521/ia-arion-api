/**
 * ARION Data Sync Script
 *
 * Pulls live data from Google Search Console, Google Business Profile,
 * and SE Ranking APIs, then writes to the arion DB tables.
 *
 * Usage: node scripts/sync-data.js
 *
 * Requires env vars: AUTH_MODE, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *   SERANKING_API_SYSTEM_KEY (set via .env or Azure App Settings)
 */

import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { getSearchConsoleData, getSearchConsolePages, getBusinessProfile, getReviews, getPerformanceMetrics } from '../lib/googleServices.js';
import { open as openToken } from '../lib/gbpTokenAtRest.js';
import { listProjects, getProject, getKeywordRankings, getAuditSummary } from '../lib/seranking.js';

const TENANT_ID = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';

async function getSitesWithTokens(pool) {
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
    .query(`SELECT site_id, tenant_id, domain, gbp_oauth_token_ref, gbp_connected, gsc_connected,
                   se_ranking_project_id, seo_addon_tier, ga4_property_id, gbp_place_id
            FROM arion.site WHERE tenant_id = @tenantId`);
  // The stored token may be sealed (lib/gbpTokenAtRest.js): open it once here.
  return result.recordset.map((s) => ({ ...s, gbp_oauth_token_ref: openToken(s.gbp_oauth_token_ref) }));
}

// ──────────────────────────────────────────────────────
// Google Search Console Sync
// ──────────────────────────────────────────────────────
async function syncGsc(pool, site) {
  if (!site.gsc_connected || !site.gbp_oauth_token_ref) {
    console.log(`  [GSC] Skipping ${site.domain} — not connected or no token`);
    return;
  }

  const siteUrl = 'https://' + site.domain;
  console.log(`  [GSC] Fetching data for ${siteUrl}...`);

  // Get query-level data
  const queryData = await getSearchConsoleData(site.gbp_oauth_token_ref, siteUrl, 28);
  if (!queryData) {
    console.log('  [GSC] No data returned from API');
    return;
  }

  // Get page-level data
  const pageData = await getSearchConsolePages(site.gbp_oauth_token_ref, siteUrl, 28);

  const today = new Date().toISOString().split('T')[0];
  let inserted = 0;

  // Insert query rows
  for (const row of queryData.queries || []) {
    try {
      await pool.request()
        .input('gscId', sql.UniqueIdentifier, crypto.randomUUID())
        .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('reportDate', sql.Date, today)
        .input('query', sql.NVarChar(500), row.query)
        .input('page', sql.NVarChar(1000), null)
        .input('clicks', sql.Int, row.clicks)
        .input('impressions', sql.Int, row.impressions)
        .input('ctr', sql.Decimal(8, 6), row.ctr)
        .input('position', sql.Decimal(8, 2), row.position)
        .query(`INSERT INTO arion.gsc_data (gsc_id, tenant_id, site_id, report_date, query, page, clicks, impressions, ctr, position)
                VALUES (@gscId, @tenantId, @siteId, @reportDate, @query, @page, @clicks, @impressions, @ctr, @position)`);
      inserted++;
    } catch (err) {
      if (!err.message.includes('duplicate')) console.error('  [GSC] Insert error:', err.message);
    }
  }

  // Insert page rows
  for (const row of pageData || []) {
    try {
      await pool.request()
        .input('gscId', sql.UniqueIdentifier, crypto.randomUUID())
        .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('reportDate', sql.Date, today)
        .input('query', sql.NVarChar(500), null)
        .input('page', sql.NVarChar(1000), row.page)
        .input('clicks', sql.Int, row.clicks)
        .input('impressions', sql.Int, row.impressions)
        .input('ctr', sql.Decimal(8, 6), row.ctr)
        .input('position', sql.Decimal(8, 2), row.position)
        .query(`INSERT INTO arion.gsc_data (gsc_id, tenant_id, site_id, report_date, query, page, clicks, impressions, ctr, position)
                VALUES (@gscId, @tenantId, @siteId, @reportDate, @query, @page, @clicks, @impressions, @ctr, @position)`);
      inserted++;
    } catch (err) {
      if (!err.message.includes('duplicate')) console.error('  [GSC] Insert error:', err.message);
    }
  }

  console.log(`  [GSC] Inserted ${inserted} rows for ${site.domain}`);
}

// ──────────────────────────────────────────────────────
// Google Business Profile Sync
// ──────────────────────────────────────────────────────
async function syncGbp(pool, site) {
  if (!site.gbp_connected || !site.gbp_oauth_token_ref) {
    console.log(`  [GBP] Skipping ${site.domain} — not connected or no token`);
    return;
  }

  console.log(`  [GBP] Fetching profile for ${site.domain}...`);

  // Get profile
  const profile = await getBusinessProfile(site.gbp_oauth_token_ref);
  if (!profile || !profile.locations || profile.locations.length === 0) {
    console.log('  [GBP] No locations found');
    return;
  }

  const loc = profile.locations[0];
  const acct = profile.accounts?.[0];

  // Upsert gbp_profile
  const existing = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .query('SELECT profile_id FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId');

  if (existing.recordset.length === 0) {
    await pool.request()
      .input('profileId', sql.UniqueIdentifier, crypto.randomUUID())
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('businessName', sql.NVarChar(200), loc.title || null)
      .input('phone', sql.NVarChar(30), loc.phone || null)
      .input('website', sql.NVarChar(500), loc.websiteUrl || null)
      .input('address', sql.NVarChar(sql.MAX), loc.address ? JSON.stringify(loc.address) : null)
      .input('categories', sql.NVarChar(sql.MAX), loc.primaryCategory || null)
      .query(`INSERT INTO arion.gbp_profile (profile_id, tenant_id, site_id, business_name, phone, website, address, categories)
              VALUES (@profileId, @tenantId, @siteId, @businessName, @phone, @website, @address, @categories)`);
    console.log('  [GBP] Created profile for', loc.title);
  } else {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('businessName', sql.NVarChar(200), loc.title || null)
      .input('phone', sql.NVarChar(30), loc.phone || null)
      .input('website', sql.NVarChar(500), loc.websiteUrl || null)
      .input('address', sql.NVarChar(sql.MAX), loc.address ? JSON.stringify(loc.address) : null)
      .input('categories', sql.NVarChar(sql.MAX), loc.primaryCategory || null)
      .query(`UPDATE arion.gbp_profile SET business_name=@businessName, phone=@phone, website=@website,
              address=@address, categories=@categories, last_synced_at=SYSDATETIMEOFFSET(), updated_at=SYSDATETIMEOFFSET()
              WHERE tenant_id=@tenantId AND site_id=@siteId`);
    console.log('  [GBP] Updated profile for', loc.title);
  }

  // Get reviews if we have account + location
  if (acct?.name && loc.name) {
    console.log('  [GBP] Fetching reviews...');
    const reviewData = await getReviews(site.gbp_oauth_token_ref, acct.name, loc.name);
    if (reviewData?.reviews) {
      let reviewCount = 0;
      for (const r of reviewData.reviews) {
        try {
          const ratingNum = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[r.starRating] || 0;
          await pool.request()
            .input('reviewId', sql.UniqueIdentifier, crypto.randomUUID())
            .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
            .input('siteId', sql.UniqueIdentifier, site.site_id)
            .input('gbpReviewId', sql.NVarChar(200), r.reviewId)
            .input('reviewerName', sql.NVarChar(200), r.reviewer || 'Anonymous')
            .input('starRating', sql.Int, ratingNum)
            .input('reviewText', sql.NVarChar(sql.MAX), r.comment || null)
            .input('replyText', sql.NVarChar(sql.MAX), r.reviewReply || null)
            .input('reviewDate', sql.DateTimeOffset, r.createTime ? new Date(r.createTime) : null)
            .query(`IF NOT EXISTS (SELECT 1 FROM arion.gbp_review WHERE tenant_id=@tenantId AND gbp_review_id=@gbpReviewId)
                    INSERT INTO arion.gbp_review (review_id, tenant_id, site_id, gbp_review_id, reviewer_name, star_rating, review_text, reply_text, review_date, synced_at)
                    VALUES (@reviewId, @tenantId, @siteId, @gbpReviewId, @reviewerName, @starRating, @reviewText, @replyText, @reviewDate, SYSDATETIMEOFFSET())`);
          reviewCount++;
        } catch (err) {
          console.error('  [GBP] Review insert error:', err.message);
        }
      }
      console.log(`  [GBP] Synced ${reviewCount} reviews`);

      // Update review stats on profile
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('reviewCount', sql.Int, reviewData.totalReviewCount || reviewCount)
        .input('avgRating', sql.Decimal(3, 2), reviewData.averageRating || 0)
        .query(`UPDATE arion.gbp_profile SET review_count=@reviewCount, avg_rating=@avgRating, updated_at=SYSDATETIMEOFFSET()
                WHERE tenant_id=@tenantId AND site_id=@siteId`);
    }
  }

  // Get performance metrics (insights)
  if (loc.name) {
    console.log('  [GBP] Fetching performance metrics...');
    const perf = await getPerformanceMetrics(site.gbp_oauth_token_ref, loc.name, 30);
    if (perf?.multiDailyMetricTimeSeries) {
      const today = new Date().toISOString().split('T')[0];
      let totalImpressions = 0, totalWebClicks = 0, totalDirections = 0, totalCalls = 0;

      for (const series of perf.multiDailyMetricTimeSeries) {
        const metric = series.dailyMetric;
        const total = (series.timeSeries?.datedValues || []).reduce((sum, v) => sum + parseInt(v.value || '0', 10), 0);
        if (metric?.includes('IMPRESSIONS')) totalImpressions += total;
        if (metric === 'WEBSITE_CLICKS') totalWebClicks = total;
        if (metric === 'CALL_CLICKS') totalCalls = total;
        if (metric === 'BUSINESS_DIRECTION_REQUESTS') totalDirections = total;
      }

      // Upsert insight
      const existingInsight = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('snapshotDate', sql.Date, today)
        .query('SELECT insight_id FROM arion.gbp_insights WHERE tenant_id=@tenantId AND site_id=@siteId AND snapshot_date=@snapshotDate');

      if (existingInsight.recordset.length === 0) {
        await pool.request()
          .input('insightId', sql.UniqueIdentifier, crypto.randomUUID())
          .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .input('snapshotDate', sql.Date, today)
          .input('searchImpressions', sql.Int, totalImpressions)
          .input('websiteClicks', sql.Int, totalWebClicks)
          .input('directionRequests', sql.Int, totalDirections)
          .input('callClicks', sql.Int, totalCalls)
          .query(`INSERT INTO arion.gbp_insights (insight_id, tenant_id, site_id, snapshot_date, search_impressions, website_clicks, direction_requests, call_clicks)
                  VALUES (@insightId, @tenantId, @siteId, @snapshotDate, @searchImpressions, @websiteClicks, @directionRequests, @callClicks)`);
        console.log(`  [GBP] Inserted insights: ${totalImpressions} impressions, ${totalWebClicks} clicks, ${totalDirections} directions, ${totalCalls} calls`);
      } else {
        console.log('  [GBP] Insights already exist for today');
      }
    }
  }
}

// ──────────────────────────────────────────────────────
// SE Ranking Sync
// ──────────────────────────────────────────────────────
async function syncSeRanking(pool, site) {
  if (!site.seo_addon_tier) {
    console.log(`  [SEO] Skipping ${site.domain} — no SEO addon tier`);
    return;
  }

  console.log(`  [SEO] Fetching SE Ranking data for ${site.domain}...`);

  // Find the project for this domain
  const projects = await listProjects();
  if (!projects) {
    console.log('  [SEO] Failed to list projects');
    return;
  }

  const domain = (site.domain || '').replace(/^www\./, '').toLowerCase();
  const project = projects.find(p => {
    const raw = (p.url || p.domain || p.site || p.name || '').toLowerCase();
    const pDomain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    return pDomain === domain || raw.includes(domain);
  });

  if (!project) {
    console.log(`  [SEO] No SE Ranking project found for domain ${domain}`);
    console.log('  [SEO] Available projects:', projects.map(p => p.url || p.domain || p.site || p.name).join(', '));
    return;
  }

  const projectId = project.id || project.project_id;
  console.log(`  [SEO] Found project ${projectId} for ${domain}`);

  // Update site with project ID if not set
  if (!site.se_ranking_project_id) {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('projectId', sql.NVarChar(50), String(projectId))
      .query('UPDATE arion.site SET se_ranking_project_id=@projectId, updated_at=SYSDATETIMEOFFSET() WHERE tenant_id=@tenantId AND site_id=@siteId');
    console.log('  [SEO] Linked project ID to site');
  }

  // Get project details
  const detail = await getProject(projectId);

  // Get keyword rankings
  const rankings = await getKeywordRankings(projectId, {});

  // Build summary
  const trackedKeywords = rankings?.length || detail?.keywords_count || 0;
  let visibilityScore = null;
  let auditScore = null;

  // Try to get audit data
  if (detail?.audit_id) {
    const audit = await getAuditSummary(detail.audit_id);
    if (audit) auditScore = audit.score || audit.audit_score || null;
  }

  // Insert summary
  await pool.request()
    .input('summaryId', sql.UniqueIdentifier, crypto.randomUUID())
    .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .input('visibilityScore', sql.Decimal(8, 2), visibilityScore)
    .input('auditScore', sql.Int, auditScore)
    .input('trackedKeywords', sql.Int, trackedKeywords)
    .input('trackedCompetitors', sql.Int, detail?.competitors_count || 0)
    .query(`INSERT INTO arion.se_ranking_summary (summary_id, tenant_id, site_id, visibility_score, audit_score, tracked_keywords, tracked_competitors)
            VALUES (@summaryId, @tenantId, @siteId, @visibilityScore, @auditScore, @trackedKeywords, @trackedCompetitors)`);

  console.log(`  [SEO] Inserted summary: ${trackedKeywords} keywords tracked`);
}

// ──────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────
async function main() {
  console.log('═══ ARION Data Sync ═══');
  console.log('Time:', new Date().toISOString());
  console.log();

  try {
    const pool = await getServicesPool();
    const sites = await getSitesWithTokens(pool);
    console.log(`Found ${sites.length} site(s) for tenant ${TENANT_ID}`);

    for (const site of sites) {
      console.log(`\n── Site: ${site.domain} (${site.site_id}) ──`);
      console.log(`   Tier: ${site.seo_addon_tier || 'none'} | GSC: ${site.gsc_connected ? 'yes' : 'no'} | GBP: ${site.gbp_connected ? 'yes' : 'no'} | Token: ${site.gbp_oauth_token_ref ? 'present' : 'MISSING'}`);

      await syncGsc(pool, site);
      await syncGbp(pool, site);
      await syncSeRanking(pool, site);
    }

    console.log('\n═══ Sync complete ═══');
  } catch (err) {
    console.error('Fatal sync error:', err);
  }

  process.exit(0);
}

main();
