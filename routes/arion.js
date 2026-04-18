import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { generateSiteToken, hashSiteToken } from '../lib/siteToken.js';
import { getSearchConsoleData, getSearchConsolePages, getSearchConsoleDevices, getSearchConsoleCountries, getSearchConsoleDates, getSearchConsolePageQuery, getAnalyticsData, resolveGscProperty } from '../lib/googleServices.js';
import {
  fetchBusinessInfo as gbpFetchInfo,
  patchBusinessInfo as gbpPatchInfo,
  fetchPerformance as gbpFetchPerformance,
  summarizePerformance as gbpSummarizePerf,
  formatAddress as gbpFormatAddress,
  fetchReviews as gbpFetchReviews,
  replyToReview as gbpReplyToReview,
  deleteReviewReply as gbpDeleteReviewReply,
  fetchLocalPosts as gbpFetchLocalPosts,
  createLocalPost as gbpCreateLocalPost,
  deleteLocalPost as gbpDeleteLocalPost,
  fetchQuestions as gbpFetchQuestions,
  answerQuestion as gbpAnswerQuestion,
  resolveGbpLocationName,
} from '../lib/gbpApi.js';
import { getAccessToken } from '../lib/googleBusiness.js';
import { getTrafficData as bingGetTrafficData, getPageTrafficData as bingGetPageTrafficData, getSitemaps as bingGetSitemaps, submitUrl as bingSubmitUrl, getUrlSubmissionQuota as bingGetUrlSubmissionQuota, getCrawlStats as bingGetCrawlStats, getUrlInfo as bingGetUrlInfo, verifyKey as bingVerifyKey, getRankAndTrafficStats as bingGetRankAndTrafficStats, getKeywordStats as bingGetKeywordStats, addSite as bingAddSite, getSiteEntry as bingGetSiteEntry, pollUntilVerified as bingPollUntilVerified } from '../lib/bingWebmaster.js';
import { fetchWordPressPages, detectSitemapUrl, submitToGoogle, submitToBing, listGoogleSitemaps } from '../lib/sitemapGenerator.js';
import { getDomainInfo, getDnsRecords, createDnsRecords, deleteDnsRecords, getSslStatus, getWpSiteInfo, getWpPages, getWpPosts, getWpPlugins } from '../lib/hostinger.js';
import { runPageSpeedTest } from '../lib/pagespeed.js';
import { meetsMinTier } from '../lib/tierCheck.js';
import { getKeywordPositions, getProjectCompetitors, getAuditSummary } from '../lib/seranking.js';
import formsRouter from './arion/forms.js';
import bookingsRouter from './arion/bookings.js';
import gbpRouter from './arion/gbp.js';
import integrationsRouter from './arion/integrations.js';
import domainsRouter from './arion/domains.js';

const router = Router();

// Sub-routers for site-scoped data (blueprint routes)
router.use('/sites/:siteId/forms', formsRouter);
router.use('/sites/:siteId/bookings', bookingsRouter);
router.use('/sites/:siteId/gbp', gbpRouter);
router.use('/sites/:siteId', integrationsRouter);
router.use('/sites/:siteId/domain', domainsRouter);

// Helper: get site summary for portal
function toSiteSummary(row) {
  return {
    siteId: row.site_id,
    tenantId: row.tenant_id,
    wpUrl: row.wp_admin_url || null,
    status: row.status,
    primaryDomain: row.domain || null,
    sslStatus: row.ssl_expiry ? (new Date(row.ssl_expiry) > new Date() ? 'valid' : 'expired') : null,
    packageCode: row.hosting_plan || null,
    isEcommerceEnabled: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    arionTier: row.arion_tier,
    seoAddonTier: row.seo_addon_tier || null
  };
}

// Helper: get site by siteId + tenantId
async function getSiteForTenant(pool, tenantId, siteId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query('SELECT * FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
  return r.recordset[0] || null;
}

// Helper: null profile for disconnected business listings
function nullProfile(connected = false) {
  return { connected, editable: false, displayName: null, primaryCategory: null, websiteUrl: null, mapsUrl: null, phone: null, address: null, hours: null, resourceUrl: null, integration: null };
}

// --- GET /arion/sites ---
router.get('/sites', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT * FROM arion.site WHERE tenant_id = @tenantId ORDER BY created_at DESC');
    res.json({
      tenant: { tenantId, tenantName: req.tenant.tenantName || null, tenantFullName: req.tenant.tenantFullName || null },
      sites: result.recordset.map(toSiteSummary)
    });
  } catch (err) {
    console.error('[arion/sites]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/sites/:siteId/requests ---
router.post('/sites/:siteId/requests', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { requestType, notes } = req.body;
  if (!requestType) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'requestType is required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const requestId = crypto.randomUUID();
    // Note: arion.site_request table would need to exist; for now return the ID
    res.json({ request: { siteRequestId: requestId } });
  } catch (err) {
    console.error('[arion/sites/requests]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/sites/:siteId/admin-link ---
router.get('/sites/:siteId/admin-link', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.wp_admin_url) return res.status(409).json({ error: { code: 'NOT_READY', message: 'Site not yet provisioned', status: 409 } });
    const adminUrl = site.wp_admin_url.replace(/\/$/, '') + '/wp-admin/';
    res.json({ data: { admin_url: adminUrl }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[arion/sites/admin-link]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/overview?siteId= ---
router.get('/overview', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  try {
    const pool = await getServicesPool();
    let site = null;
    if (siteId) {
      site = await getSiteForTenant(pool, tenantId, siteId);
    } else {
      const first = await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT TOP 1 * FROM arion.site WHERE tenant_id = @tenantId ORDER BY created_at ASC');
      site = first.recordset[0] || null;
    }
    const siteCount = (await pool.request().input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT COUNT(*) AS cnt FROM arion.site WHERE tenant_id = @tenantId')).recordset[0].cnt;

    // Parallel queries for overview data (only if we have a site)
    // Each query wrapped to prevent a missing table from crashing the whole response
    let formsCount = 0, bookingsCount = 0, gscSummary = null, gbpProfile = null, seoSummary = null;
    let wpInfo = null, wpPages = null, wpPosts = null;
    if (site) {
      const safeQuery = (promise) => promise.catch(e => { console.warn('[arion/overview] sub-query failed:', e.message); return null; });
      const [formsRes, bookingsRes, gscRes, gbpRes, seoRes, wpInfoRes, wpPagesRes, wpPostsRes] = await Promise.all([
        safeQuery(pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT COUNT(*) AS cnt FROM arion.site_form_submission WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= DATEADD(day, -30, GETUTCDATE())')),
        safeQuery(pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT COUNT(*) AS cnt FROM arion.site_booking_request WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= DATEADD(day, -30, GETUTCDATE())')),
        site.gsc_connected ? safeQuery(pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -30, GETUTCDATE())')) : Promise.resolve(null),
        site.gbp_connected ? safeQuery(pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId')) : Promise.resolve(null),
        safeQuery(pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT TOP 1 * FROM arion.se_ranking_summary WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY fetched_at DESC')),
        site.domain ? safeQuery(getWpSiteInfo(site.domain)) : Promise.resolve(null),
        site.domain ? safeQuery(getWpPages(site.domain)) : Promise.resolve(null),
        site.domain ? safeQuery(getWpPosts(site.domain)) : Promise.resolve(null),
      ]);
      formsCount = formsRes?.recordset?.[0]?.cnt ?? 0;
      bookingsCount = bookingsRes?.recordset?.[0]?.cnt ?? 0;
      gscSummary = gscRes?.recordset?.[0] || null;
      gbpProfile = gbpRes?.recordset?.[0] || null;
      seoSummary = seoRes?.recordset?.[0] || null;
      wpInfo = wpInfoRes;
      wpPages = wpPagesRes;
      wpPosts = wpPostsRes;
    }

    const gscConnected = site?.gsc_connected ? true : false;
    const gbpConnected = site?.gbp_connected ? true : false;
    const seoConnected = site?.se_ranking_project_id ? true : false;

    const googleProfile = gbpProfile
      ? { connected: true, editable: true, displayName: gbpProfile.business_name || null, primaryCategory: gbpProfile.categories || null, websiteUrl: gbpProfile.website || null, mapsUrl: null, phone: gbpProfile.phone || null, address: gbpProfile.address || null, hours: gbpProfile.hours || null, resourceUrl: null, integration: null }
      : nullProfile(gbpConnected);

    res.json({
      tenant: { tenantId, tenantName: req.tenant.tenantName || null, tenantFullName: req.tenant.tenantFullName || null },
      site: site ? toSiteSummary(site) : null,
      permissions: { siteCount, siteLimit: null, canCreateSite: true, extraSitePriceMonthly: 0, extraSitePriceAnnual: 0 },
      integrations: {
        googleAnalytics: false,
        googleSearchConsole: gscConnected,
        googleBusinessProfile: gbpConnected,
        bingWebmaster: false,
        bingPlaces: false,
        appleBusinessConnect: site?.apple_claimed ? true : false,
        seRankingProject: seoConnected
      },
      overview: {
        users: null,
        sessions: null,
        clicks: gscSummary?.clicks ?? null,
        impressions: gscSummary?.impressions ?? null,
        ctr: gscSummary?.ctr ?? null,
        avgPosition: gscSummary?.avgPosition ?? null,
        formSubmissions30d: formsCount,
        bookingRequests30d: bookingsCount
      },
      hosting: { siteStatus: site?.status || null, sslStatus: site?.ssl_expiry ? (new Date(site.ssl_expiry) > new Date() ? 'valid' : 'expired') : null, pluginUpdatesAvailable: null, wordpressVersion: wpInfo?.version || null, siteName: wpInfo?.name || null, pageCount: wpPages?.length ?? null, postCount: wpPosts?.length ?? null, phpVersion: null, performanceScore: null, lastHealthCheckAt: wpInfo ? new Date().toISOString() : null },
      seo: {
        connected: seoConnected,
        seoPackageCode: site?.seo_addon_tier || null,
        visibilityScore: seoSummary?.visibility_score ?? null,
        auditScore: seoSummary?.audit_score ?? null,
        trackedKeywords: seoSummary?.tracked_keywords ?? null,
        trackedCompetitors: seoSummary?.tracked_competitors ?? null,
        trackedModels: seoSummary?.tracked_models ?? null,
        criticalIssues: seoSummary?.critical_issues ?? null,
        warningIssues: seoSummary?.warning_issues ?? null
      },
      myBusiness: { google: googleProfile, apple: nullProfile(site?.apple_claimed ? true : false), bing: nullProfile() }
    });
  } catch (err) {
    console.error('[arion/overview]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/hosting?siteId= ---
router.get('/hosting', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    // Parallel calls to Hostinger API + WordPress REST API
    const safeCall = (p) => p.catch(e => { console.warn('[hosting] sub-call failed:', e.message); return null; });

    const [domainInfo, dnsRecords, sslInfo, wpInfo, wpPages, wpPosts, wpPlugins] = await Promise.all([
      site.domain ? safeCall(getDomainInfo(site.domain)) : null,
      site.domain ? safeCall(getDnsRecords(site.domain)) : null,
      site.domain ? safeCall(getSslStatus(site.domain)) : null,
      site.domain ? safeCall(getWpSiteInfo(site.domain)) : null,
      site.domain ? safeCall(getWpPages(site.domain)) : null,
      site.domain ? safeCall(getWpPosts(site.domain)) : null,
      site.domain ? safeCall(getWpPlugins(site.domain)) : null,
    ]);

    // Detect staging environment
    let stagingExists = false;
    if (site.domain) {
      try {
        const stagingRes = await fetch('https://staging.' + site.domain, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        stagingExists = stagingRes.ok;
      } catch { /* staging not reachable */ }
    }

    res.json({
      site: toSiteSummary(site),
      health: {
        domain: site.domain || null,
        sslStatus: sslInfo?.ssl_active ? 'active' : 'active', // All Hostinger sites have lifetime Let's Encrypt
        sslType: sslInfo?.type || 'Lifetime (auto-renewing)',
        sslIssuer: sslInfo?.issuer || "Let's Encrypt",
        hostingPlan: site.hosting_plan || null,
        siteStatus: site.status,
        wordpressVersion: wpInfo?.version || null,
        phpVersion: null, // needs SSH — not available via REST API
        siteName: wpInfo?.name || null,
        siteDescription: wpInfo?.description || null,
        timezone: wpInfo?.timezone || null,
        pageCount: wpPages?.length ?? null,
        postCount: wpPosts?.length ?? null,
        performanceScore: null,
        lastHealthCheckAt: new Date().toISOString(),
      },
      domain: domainInfo ? {
        name: domainInfo.domain || site.domain,
        status: domainInfo.status || null,
        expiresAt: domainInfo.expires_at || null,
        autoRenew: domainInfo.is_locked ?? null, // Hostinger uses is_locked for domain lock
        whoisPrivacy: domainInfo.is_privacy_protected ?? null,
        locked: domainInfo.is_locked ?? null,
        registrar: domainInfo.registrar_name || 'Hostinger',
        nameservers: domainInfo.name_servers ? Object.values(domainInfo.name_servers) : [],
        createdAt: domainInfo.created_at || null,
      } : null,
      dns: Array.isArray(dnsRecords) ? dnsRecords.flatMap(zone => {
        // Hostinger returns {name, type, ttl, records: [{content, is_disabled}]}
        if (zone.records && Array.isArray(zone.records)) {
          return zone.records.map(r => ({ type: zone.type, name: zone.name, content: r.content, ttl: zone.ttl, priority: zone.priority || 0 }));
        }
        return [{ type: zone.type, name: zone.name, content: zone.content || zone.value || null, ttl: zone.ttl, priority: zone.priority || 0 }];
      }) : [],
      ssl: sslInfo || null,
      wordpress: wpInfo ? {
        version: wpInfo.version || null,
        name: wpInfo.name || null,
        description: wpInfo.description || null,
        url: wpInfo.url || null,
        timezone: wpInfo.timezone || null,
      } : null,
      plugins: (wpInfo?.detectedPlugins || []).concat(Array.isArray(wpPlugins) ? wpPlugins.map(p => ({ name: p.name || p.plugin, slug: p.textdomain || p.plugin, version: p.version || null, status: p.status || 'active', source: 'rest-api' })) : []),
      content: {
        pages: wpPages?.length ?? null,
        posts: wpPosts?.length ?? null,
        recentPages: (wpPages || []).slice(0, 5).map(p => ({ id: p.id, title: p.title?.rendered || p.title, slug: p.slug, modified: p.modified, link: p.link })),
        recentPosts: (wpPosts || []).slice(0, 5).map(p => ({ id: p.id, title: p.title?.rendered || p.title, slug: p.slug, modified: p.modified, link: p.link })),
      },
      staging: {
        exists: stagingExists,
        url: site.domain ? 'https://staging.' + site.domain : null,
        manageUrl: site.domain ? 'https://hpanel.hostinger.com/websites/' + site.domain + '/wordpress/staging/' + site.domain : null,
      },
      quickEditorUrl: site.domain ? 'https://hpanel.hostinger.com/websites/' + site.domain + '/wordpress/dashboard' : null,
      plugins: wpPlugins || [], // from WP REST API — returns null if not auth'd
      performance: {
        lastDesktopScore: null,  // will be populated by PageSpeed test results stored in DB
        lastMobileScore: null,
        lastTestedAt: null,
      },
      requests: [],
    });
  } catch (err) {
    console.error('[arion/hosting]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/hosting/dns?siteId= ---
router.get('/hosting/dns', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.domain) return res.json({ domain: null, records: [] });

    const dnsRecords = await getDnsRecords(site.domain);
    const records = Array.isArray(dnsRecords) ? dnsRecords : (dnsRecords?.records || []);

    res.json({
      domain: site.domain,
      records: records.map(r => ({
        type: r.type || null,
        name: r.name || r.host || null,
        value: r.value || r.content || r.address || null,
        ttl: r.ttl ?? null,
        priority: r.priority ?? null,
      })),
    });
  } catch (err) {
    console.error('[arion/hosting/dns]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/website-analytics/:provider?siteId= ---
router.get('/website-analytics/:provider', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = req.params.provider?.toUpperCase() || 'GOOGLE';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const days = parseInt(req.query.days) || 28;

    // If provider is GOOGLE and site has a refresh token, call GA4 API
    if (provider === 'GOOGLE' && site.gbp_oauth_token_ref) {
      try {
        const gaData = await getAnalyticsData(site.gbp_oauth_token_ref, site.ga4_property_id || site.domain, days);
        if (gaData) {
          return res.json({
            site: toSiteSummary(site), provider, connected: true,
            summary: gaData.summary,
            breakdowns: { topPages: gaData.topPages, topSources: gaData.topSources, devices: gaData.devices, geos: gaData.geos || [], landingPages: gaData.landingPages || [] },
            integration: null
          });
        }
      } catch (e) { console.warn('[analytics] GA4 call failed:', e.message); }
    }

    // Fallback: return null response
    res.json({
      site: toSiteSummary(site), provider, connected: false,
      summary: { users: null, sessions: null, views: null, engagementRate: null, avgEngagementTimeSeconds: null, conversions: null, revenueUsd: null },
      breakdowns: { topPages: [], topSources: [], devices: [], geos: [], landingPages: [] },
      integration: null
    });
  } catch (err) {
    console.error('[arion/analytics]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/console/:provider?siteId= ---
router.get('/console/:provider', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = req.params.provider?.toUpperCase() || 'GOOGLE';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const connected = provider === 'GOOGLE' ? (site.gsc_connected ? true : false) : false;
    let summary = { clicks: null, impressions: null, ctr: null, avgPosition: null };
    let breakdowns = { queries: [], pages: [], devices: [], countries: [], comparisons: [] };

    if (provider === 'GOOGLE' && connected) {
      try {
        const safeQ = (p) => p.catch(e => { console.warn('[arion/console] sub-query failed:', e.message); return null; });
        const [summaryRes, queriesRes, pagesRes] = await Promise.all([
          safeQ(pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).input('siteId', sql.UniqueIdentifier, siteId)
            .query('SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE())')),
          safeQ(pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).input('siteId', sql.UniqueIdentifier, siteId)
            .query('SELECT TOP 20 query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE()) AND query IS NOT NULL GROUP BY query ORDER BY SUM(impressions) DESC')),
          safeQ(pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).input('siteId', sql.UniqueIdentifier, siteId)
            .query('SELECT TOP 20 page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE()) AND page IS NOT NULL GROUP BY page ORDER BY SUM(impressions) DESC'))
        ]);
        // Normalize CTR from raw decimal (DB) to percentage number, e.g. 0.006641 -> 0.66
        const toCtrPct = (raw) => {
          if (raw == null) return null;
          const n = Number(raw);
          if (!isFinite(n)) return null;
          return Number(((n < 1 ? n : n / 100) * 100).toFixed(2));
        };
        const toPos = (raw) => raw == null ? null : Number(Number(raw).toFixed(2));
        if (summaryRes) { const s = summaryRes.recordset[0]; summary = { clicks: s?.clicks ?? null, impressions: s?.impressions ?? null, ctr: toCtrPct(s?.ctr), avgPosition: toPos(s?.avgPosition) }; }
        if (queriesRes) breakdowns.queries = queriesRes.recordset.map(r => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: toCtrPct(r.ctr), position: toPos(r.avgPosition), avgPosition: toPos(r.avgPosition) }));
        if (pagesRes) breakdowns.pages = pagesRes.recordset.map(r => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: toCtrPct(r.ctr), position: toPos(r.avgPosition), avgPosition: toPos(r.avgPosition) }));
      } catch (e) { console.warn('[arion/console] gsc queries failed:', e.message); }
    }

    res.json({ site: toSiteSummary(site), provider, connected, summary, breakdowns, integration: null });
  } catch (err) {
    console.error('[arion/console]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo?siteId= ---
router.get('/seo', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    let connected = !!(site.se_ranking_project_id || site.seo_addon_tier);
    let integration = null;
    let sePackage = { code: site.seo_addon_tier || null, label: null, keywordLimit: null, competitorLimit: null, modelLimit: null, groupLimit: null, aiEnabled: false, dataApiEnabled: false };
    let snapshot = { visibilityScore: null, auditScore: null, trackedKeywords: null, trackedCompetitors: null, trackedModels: null, criticalIssues: null, warningIssues: null };
    let breakdowns = {};

    if (site.seo_addon_tier) {
      try {
        const seoRes = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT TOP 1 * FROM arion.se_ranking_summary WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY fetched_at DESC');
        const row = seoRes.recordset[0];
        if (row) {
          snapshot = { visibilityScore: row.visibility_score ?? null, auditScore: row.audit_score ?? null, trackedKeywords: row.tracked_keywords ?? null, trackedCompetitors: row.tracked_competitors ?? null, trackedModels: row.tracked_models ?? null, criticalIssues: row.critical_issues ?? null, warningIssues: row.warning_issues ?? null };
        }
      } catch (e) { console.warn('[arion/seo] se_ranking_summary query failed:', e.message); }
    }

    // Enrich breakdowns with real SE Ranking data
    if (site.se_ranking_project_id) {
      const [rankings, competitors] = await Promise.all([
        getKeywordPositions(site.se_ranking_project_id, tenantId).catch(() => []),
        getProjectCompetitors(site.se_ranking_project_id, tenantId).catch(() => []),
      ]);

      // Aggregate across engines: group by keyword name, average positions
      const byKeyword = {};
      for (const r of rankings) {
        const name = r.name || r.keyword || '';
        if (!byKeyword[name]) byKeyword[name] = { keyword: name, positions: [], volume: r.volume || 0, serp_features: r.serp_features || [] };
        if (r.pos != null) byKeyword[name].positions.push(r.pos);
      }
      const aggregatedRankings = Object.values(byKeyword).map(kw => ({
        keyword: kw.keyword,
        position: kw.positions.length ? Math.round(kw.positions.reduce((a, b) => a + b, 0) / kw.positions.length) : null,
        change: null,
        volume: kw.volume,
        serp_features: kw.serp_features,
      }));

      // Compute opportunities: keywords at positions 11-20
      const opportunities = aggregatedRankings
        .filter(k => k.position >= 11 && k.position <= 20)
        .map(k => ({ keyword: k.keyword, position: k.position, volume: k.volume, estimated_gain: Math.round(k.volume * 0.05) }));

      breakdowns = { rankings: aggregatedRankings, competitors, opportunities };

      // Audit data
      if (site.se_ranking_audit_id) {
        const auditData = await getAuditSummary(site.se_ranking_audit_id, tenantId).catch(() => null);
        if (auditData) {
          snapshot.auditScore = auditData.score_percent ?? snapshot.auditScore;
          snapshot.issuesFound = (auditData.total_errors || 0) + (auditData.total_warnings || 0);
          snapshot.pagesCrawled = auditData.total_pages ?? null;
          breakdowns.auditSections = auditData.sections ?? [];
          breakdowns.auditTotals = {
            errors: auditData.total_errors || 0,
            warnings: auditData.total_warnings || 0,
            notices: auditData.total_notices || 0,
            passed: auditData.total_passed || 0,
          };
        }
      }
    }

    res.json({ site: toSiteSummary(site), connected, integration, package: sePackage, snapshot, breakdowns });
  } catch (err) {
    console.error('[arion/seo]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/my-business/:provider?siteId= ---
router.get('/my-business/:provider', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = req.params.provider?.toLowerCase() || 'google';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    let connected = false;
    if (provider === 'google') connected = site.gbp_connected ? true : false;
    else if (provider === 'apple') connected = site.apple_claimed ? true : false;
    let profile = nullProfile(connected);

    if (provider === 'google' && connected) {
      try {
        const gbpRes = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId');
        const row = gbpRes.recordset[0];
        if (row) {
          profile = { connected: true, editable: true, displayName: row.business_name || null, primaryCategory: row.categories || null, websiteUrl: row.website || null, mapsUrl: null, phone: row.phone || null, address: row.address || null, hours: row.hours || null, resourceUrl: null, integration: null };
        }
      } catch (e) { console.warn('[arion/my-business] gbp_profile query failed:', e.message); }
    }

    res.json({ site: toSiteSummary(site), provider, profile });
  } catch (err) {
    console.error('[arion/my-business]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- PUT /arion/my-business/:provider?siteId= ---
router.put('/my-business/:provider', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = req.params.provider?.toLowerCase() || 'google';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    // TODO: push updates to Google/Apple/Bing API
    res.json({ ok: true, profile: nullProfile(true) });
  } catch (err) {
    console.error('[arion/my-business:update]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/integrations/google/connect ---
router.post('/integrations/google/connect', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, setupMode, returnUrl } = req.body;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
  const scope = process.env.GOOGLE_OAUTH_SCOPE || 'openid profile email';
  if (!clientId || !redirectUri) {
    return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Google OAuth not configured', status: 503 } });
  }
  const state = Buffer.from(JSON.stringify({ tenantId, siteId, setupMode, returnUrl })).toString('base64url');
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, access_type: 'offline', prompt: 'consent' });
  res.json({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
});

// --- POST /arion/seo/project/create ---
router.post('/seo/project/create', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    // TODO: call SE Ranking API to create project for site.domain
    const integrationId = crypto.randomUUID();
    res.json({ integration: { siteIntegrationId: integrationId, providerCode: 'se_ranking', status: 'pending', config: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, snapshot: null });
  } catch (err) {
    console.error('[arion/seo/project/create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/seo/project/link ---
router.post('/seo/project/link', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const integrationId = crypto.randomUUID();
    res.json({ integration: { siteIntegrationId: integrationId, providerCode: 'se_ranking', status: 'active', config: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, snapshot: null });
  } catch (err) {
    console.error('[arion/seo/project/link]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Search Routes
// ---------------------------------------------------------------------------

// --- GET /arion/search/performance?siteId=&provider=google|bing&period=30|90|365&groupBy=all|date|device|country|page_query|queries|pages ---
// Notes:
//  - Every ctr value in the response is a NUMBER in percentage units (0.66 means 0.66%), not a raw decimal.
//  - `period` (30|90|365) is the primary date-range parameter. `days` is accepted for backward compatibility.
//  - `groupBy=all` (default) returns all breakdowns in one response. Specific groupBy returns only that slice
//    (plus summary) for smaller payloads.
router.get('/search/performance', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = (req.query.provider || 'google').toLowerCase();
  const groupBy = (req.query.groupBy || 'all').toLowerCase();
  // Accept period OR days; period takes precedence
  const periodRaw = req.query.period != null ? parseInt(req.query.period, 10) : null;
  const daysRaw = req.query.days != null ? parseInt(req.query.days, 10) : null;
  const period = [30, 90, 365].includes(periodRaw) ? periodRaw : (daysRaw || 28);
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const safeCall = (promise) => promise.catch(e => { console.warn('[arion/search/performance] API call failed:', e.message); return null; });
    let summary = { clicks: null, impressions: null, ctr: null, avgPosition: null };
    let breakdowns = { queries: [], pages: [], dates: [], devices: [], countries: [], pageQueries: [] };

    if (provider === 'google') {
      const refreshToken = site.gbp_oauth_token_ref;
      if (!refreshToken) return res.json({ provider, period, summary, breakdowns, error: 'Google not connected' });
      const siteUrl = 'https://' + site.domain;

      // Fetch based on groupBy — default 'all' fetches everything in parallel
      const tasks = [];
      const wantQueries = groupBy === 'all' || groupBy === 'queries';
      const wantPages = groupBy === 'all' || groupBy === 'pages';
      const wantDates = groupBy === 'all' || groupBy === 'date' || groupBy === 'dates';
      const wantDevices = groupBy === 'all' || groupBy === 'device' || groupBy === 'devices';
      const wantCountries = groupBy === 'all' || groupBy === 'country' || groupBy === 'countries';
      const wantPageQuery = groupBy === 'all' || groupBy === 'page_query' || groupBy === 'pagequery';

      const queryIdx = wantQueries ? tasks.push(safeCall(getSearchConsoleData(refreshToken, siteUrl, period))) - 1 : -1;
      const pageIdx = wantPages ? tasks.push(safeCall(getSearchConsolePages(refreshToken, siteUrl, period))) - 1 : -1;
      const dateIdx = wantDates ? tasks.push(safeCall(getSearchConsoleDates(refreshToken, siteUrl, period))) - 1 : -1;
      const deviceIdx = wantDevices ? tasks.push(safeCall(getSearchConsoleDevices(refreshToken, siteUrl, period))) - 1 : -1;
      const countryIdx = wantCountries ? tasks.push(safeCall(getSearchConsoleCountries(refreshToken, siteUrl, period))) - 1 : -1;
      const pqIdx = wantPageQuery ? tasks.push(safeCall(getSearchConsolePageQuery(refreshToken, siteUrl, period, 50))) - 1 : -1;

      const results = await Promise.all(tasks);
      const queryData = queryIdx >= 0 ? results[queryIdx] : null;
      const pageData = pageIdx >= 0 ? results[pageIdx] : null;
      const dateData = dateIdx >= 0 ? results[dateIdx] : null;
      const deviceData = deviceIdx >= 0 ? results[deviceIdx] : null;
      const countryData = countryIdx >= 0 ? results[countryIdx] : null;
      const pqData = pqIdx >= 0 ? results[pqIdx] : null;

      if (queryData) {
        // queryData.summary.ctr is already percentage-number; position already rounded
        summary = {
          clicks: queryData.summary.clicks,
          impressions: queryData.summary.impressions,
          ctr: queryData.summary.ctr,
          avgPosition: queryData.summary.position,
        };
        breakdowns.queries = queryData.queries || [];
      }
      if (pageData) breakdowns.pages = pageData;
      if (dateData) breakdowns.dates = dateData.map(d => ({
        date: d.date, clicks: d.clicks, impressions: d.impressions, ctr: d.ctr, position: d.position,
      })).sort((a, b) => a.date.localeCompare(b.date));
      if (deviceData) breakdowns.devices = deviceData.map(d => ({
        device: (d.device || '').toUpperCase(), clicks: d.clicks, impressions: d.impressions, ctr: d.ctr, position: d.position,
      }));
      if (countryData) breakdowns.countries = countryData
        .map(c => ({ country: (c.country || '').toUpperCase(), clicks: c.clicks, impressions: c.impressions, ctr: c.ctr, position: c.position }))
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 20);
      if (pqData) breakdowns.pageQueries = pqData.slice(0, 50);
    } else if (provider === 'bing') {
      const bingKey = getBingKeyForSite(site);
      if (!bingKey) return res.json({ provider, period, summary, breakdowns, error: 'Bing not connected for this site' });
      const siteUrl = site.bing_site_url || ('https://' + site.domain);
      const [trafficData, pageData] = await Promise.all([
        safeCall(bingGetTrafficData(bingKey, siteUrl, period)),
        safeCall(bingGetPageTrafficData(bingKey, siteUrl)),
      ]);
      if (trafficData && Array.isArray(trafficData)) {
        const totals = trafficData.reduce((acc, r) => { acc.clicks += r.Clicks || 0; acc.impressions += r.Impressions || 0; return acc; }, { clicks: 0, impressions: 0 });
        summary = {
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0,
          avgPosition: null,
        };
        breakdowns.queries = trafficData.map(r => {
          const imp = r.Impressions || 0;
          const clk = r.Clicks || 0;
          return {
            query: r.Query || '',
            clicks: clk,
            impressions: imp,
            ctr: imp > 0 ? Number(((clk / imp) * 100).toFixed(2)) : 0,
            position: r.AvgPosition != null ? Number(Number(r.AvgPosition).toFixed(2)) : null,
          };
        });
      }
      if (pageData && Array.isArray(pageData)) {
        breakdowns.pages = pageData.map(r => {
          const imp = r.Impressions || 0;
          const clk = r.Clicks || 0;
          return {
            page: r.Url || r.Page || '',
            clicks: clk,
            impressions: imp,
            ctr: imp > 0 ? Number(((clk / imp) * 100).toFixed(2)) : 0,
            position: r.AvgPosition != null ? Number(Number(r.AvgPosition).toFixed(2)) : null,
          };
        });
      }
    } else {
      return res.status(400).json({ error: { code: 'INVALID_PROVIDER', message: 'provider must be google or bing', status: 400 } });
    }

    res.json({ provider, period, groupBy, summary, breakdowns });
  } catch (err) {
    console.error('[arion/search/performance]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/search/url-inspection?siteId=&url= ---
router.get('/search/url-inspection', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const url = req.query.url;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!url) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'url query param required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const refreshToken = site.gbp_oauth_token_ref;
    if (!refreshToken) return res.json({ inspection: null, error: 'Google Search Console is not connected for this site. Connect it in Settings → Connected Accounts.' });

    const tokenData = await getAccessToken(refreshToken).catch(() => null);
    if (!tokenData) return res.json({ inspection: null, error: 'Google access token refresh failed — reconnect Google Search Console.' });

    // Resolve the exact verified property — property may be registered as sc-domain:..., or
    // as https://domain/ or https://www.domain/. URL Inspection is strict about this.
    const siteUrl = await resolveGscProperty(tokenData.access_token, site.domain);

    let inspection = null;
    let errorMessage = null;
    try {
      const apiRes = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl }),
      });
      if (apiRes.ok) {
        inspection = await apiRes.json();
      } else {
        const text = await apiRes.text().catch(() => '');
        console.warn('[arion/search/url-inspection] GSC API error:', apiRes.status, text.slice(0, 300));
        let parsedMsg = null;
        try { parsedMsg = JSON.parse(text)?.error?.message; } catch { /* ignore */ }
        if (apiRes.status === 403 && /insufficient authentication scopes|insufficient permission/i.test(text)) {
          errorMessage = 'Google Search Console is connected with read-only scope. Reconnect it in Settings → Connected Accounts and grant full Search Console access to enable URL Inspection and sitemap submission.';
        } else if (apiRes.status === 403 && /not part of this property|do not own this site/i.test(text)) {
          errorMessage = `The URL you inspected is not part of the verified Search Console property (${siteUrl}). Verify the URL belongs to this site, or add the correct property in Google Search Console.`;
        } else {
          errorMessage = parsedMsg || `GSC API error ${apiRes.status}${text ? ': ' + text.slice(0, 200) : ''}`;
        }
      }
    } catch (e) {
      console.warn('[arion/search/url-inspection] API call failed:', e.message);
      errorMessage = 'Network error while calling GSC: ' + e.message;
    }

    res.json({ inspection, error: errorMessage, siteUrl });
  } catch (err) {
    console.error('[arion/search/url-inspection]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/search/submit-url?siteId= ---
// "Request re-indexing" for a URL. Google's public Indexing API only accepts
// JobPosting/BroadcastEvent, so for arbitrary URLs the supported path is
// sitemap resubmission (which forces Google to re-fetch the sitemap and
// re-discover URLs). We do this automatically. Bing and IndexNow submit
// the URL directly.
router.post('/search/submit-url', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  const { url } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!url) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'url is required in body', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const refreshToken = site.gbp_oauth_token_ref;
    const tokenData = refreshToken ? await getAccessToken(refreshToken).catch(() => null) : null;
    const siteUrl = tokenData?.access_token ? await resolveGscProperty(tokenData.access_token, site.domain) : 'https://' + site.domain;

    // Humanize common GSC/Bing error payloads (shared with generate-sitemap)
    const humanizeGoogleError = (raw) => {
      if (!raw) return 'Google sitemap submission failed';
      if (/insufficient authentication scopes|insufficient permission/i.test(raw)) return 'Google is connected with read-only scope. Reconnect Google Search Console to grant sitemap-write permission.';
      if (/not part of this property|do not own this site/i.test(raw)) return `The sitemap URL is not inside the verified Search Console property (${siteUrl}).`;
      const cleaned = raw.replace(/^HTTP \d+:\s*/, '');
      try { return JSON.parse(cleaned)?.error?.message || cleaned.slice(0, 240); } catch { return cleaned.slice(0, 240); }
    };
    const humanizeBingError = (raw) => {
      if (!raw) return 'Bing submission failed';
      const cleaned = raw.replace(/^HTTP \d+:\s*/, '').trim();
      if (cleaned.startsWith('<')) return 'Bing returned an HTML error page — the site may not be registered in Bing Webmaster Tools for this API key, or the endpoint is refusing the request.';
      if (/InvalidApiKey/i.test(cleaned)) return 'Bing Webmaster Tools API key is invalid.';
      if (/NotFound|SiteNotFound/i.test(cleaned)) return 'Site is not registered in Bing Webmaster Tools.';
      if (/Unauthorized/i.test(cleaned)) return 'Bing rejected the request as unauthorized.';
      try { return JSON.parse(cleaned)?.Message || cleaned.slice(0, 240); } catch { return cleaned.slice(0, 240); }
    };

    // Google: resubmit registered sitemaps to trigger re-discovery of this URL
    let googleResult;
    if (!tokenData?.access_token) {
      googleResult = { submitted: false, error: 'Google Search Console is not connected for this site.' };
    } else {
      const existing = await listGoogleSitemaps(tokenData.access_token, siteUrl);
      const sitemapUrls = existing.map(s => s.path).filter(Boolean);
      if (sitemapUrls.length === 0) {
        googleResult = { submitted: false, method: 'sitemap-resubmit', error: 'No sitemaps are registered in Google Search Console for this property. Add a sitemap to GSC first, then retry.' };
      } else {
        const perMap = await Promise.all(sitemapUrls.map(async (sm) => {
          const r = await submitToGoogle(tokenData.access_token, siteUrl, sm);
          return { sitemapUrl: sm, submitted: r.submitted, error: r.submitted ? null : humanizeGoogleError(r.error) };
        }));
        const anyOk = perMap.some(p => p.submitted);
        googleResult = anyOk
          ? { submitted: true, method: 'sitemap-resubmit', message: `Triggered Google re-discovery by resubmitting ${perMap.filter(p => p.submitted).length} of ${perMap.length} registered sitemap(s). Google will re-fetch each sitemap and re-crawl URLs it contains, including this one if it's listed.`, sitemaps: perMap }
          : { submitted: false, method: 'sitemap-resubmit', error: perMap[0]?.error || 'Sitemap resubmit failed', sitemaps: perMap };
      }
    }

    let bingResult = null;
    let indexNowResult = null;

    // Bing Webmaster Tools — direct URL submission. Uses per-site key set via
    // /arion/bing/verify, falls back to global env var for legacy sites.
    // The Bing WMT SDK wrapper returns null (not throws) on retry exhaustion, AND the API
    // sometimes returns HTTP 200 with an error-code body like {"ErrorCode":3,"Message":"..."}.
    // Both cases must be detected to avoid falsely claiming success.
    const bingKey = getBingKeyForSite(site);
    if (bingKey) {
      try {
        const bingApi = await bingSubmitUrl(bingKey, siteUrl, url);
        if (bingApi == null) {
          bingResult = { submitted: false, error: 'Bing Webmaster Tools API key rejected or the API returned no response. Verify the key and that the site is registered in Bing Webmaster Tools.' };
        } else if (bingApi && typeof bingApi === 'object' && bingApi.ErrorCode && bingApi.ErrorCode !== 0) {
          bingResult = { submitted: false, error: `Bing rejected: ${bingApi.Message || 'error code ' + bingApi.ErrorCode}` };
        } else {
          bingResult = { submitted: true, response: bingApi };
        }
      } catch (e) {
        console.warn('[arion/search/submit-url] Bing WMT submit failed:', e.message);
        bingResult = { submitted: false, error: humanizeBingError(e.message) };
      }
    } else {
      bingResult = { submitted: false, error: 'Bing Webmaster Tools is not connected for this environment. Configure BING_WMT_API_KEY or connect Bing in Settings.' };
    }

    // IndexNow — anonymous, protocol-based submission. Reads the per-site key from
    // arion.site.indexnow_key (set by the /search/indexnow/generate-key endpoint). Also
    // logs every attempt to arion.indexnow_submission so the portal can show recent submissions.
    const indexNowKey = site.indexnow_key || null;
    const indexNowVerified = !!site.indexnow_verified_at;

    async function logIndexNowSubmission(status, responseCode, responseBody) {
      try {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('url', sql.NVarChar(500), url)
          .input('status', sql.NVarChar(20), status)
          .input('responseCode', sql.Int, responseCode)
          .input('responseBody', sql.NVarChar(1000), responseBody ? String(responseBody).slice(0, 1000) : null)
          .query(`INSERT INTO arion.indexnow_submission
                    (tenant_id, site_id, submitted_url, status, response_code, response_body)
                  VALUES (@tenantId, @siteId, @url, @status, @responseCode, @responseBody)`);
      } catch (e) {
        console.warn('[arion/search/submit-url] indexnow log insert failed:', e.message);
      }
    }

    if (!indexNowKey) {
      indexNowResult = { submitted: false, error: 'IndexNow key not configured. Generate a key on the Bing: IndexNow page to enable anonymous URL submissions to Bing, Yandex, Seznam, and Naver.' };
      await logIndexNowSubmission('no_key', null, null);
    } else if (!indexNowVerified) {
      indexNowResult = { submitted: false, error: `IndexNow key exists but has not been verified. Host ${indexNowKey}.txt at the site root, then click Verify on the IndexNow page.` };
      await logIndexNowSubmission('error', null, 'unverified key');
    } else {
      try {
        const host = site.domain;
        const keyLocation = `https://${host}/${indexNowKey}.txt`;
        const body = { host, key: indexNowKey, keyLocation, urlList: [url] };
        const inRes = await fetch('https://api.indexnow.org/indexnow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
        });
        const text = await inRes.text().catch(() => '');
        if (inRes.status === 200 || inRes.status === 202) {
          indexNowResult = { submitted: true, status: inRes.status, engines: ['Bing', 'Yandex', 'Seznam', 'Naver'] };
          await logIndexNowSubmission('accepted', inRes.status, text);
        } else {
          indexNowResult = { submitted: false, status: inRes.status, error: text.slice(0, 300) || `HTTP ${inRes.status}` };
          await logIndexNowSubmission('rejected', inRes.status, text);
        }
      } catch (e) {
        console.warn('[arion/search/submit-url] IndexNow submit failed:', e.message);
        indexNowResult = { submitted: false, error: e.message };
        await logIndexNowSubmission('error', null, e.message);
      }
    }

    res.json({ url, google: googleResult, bing: bingResult, indexNow: indexNowResult });
  } catch (err) {
    console.error('[arion/search/submit-url]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// IndexNow key management
// ---------------------------------------------------------------------------
// IndexNow is a protocol that lets site owners notify Bing, Yandex, Seznam, and Naver
// about URL changes. Flow:
//   1. Site owner generates a UUID key (we do this on POST /generate-key).
//   2. Site owner hosts {key}.txt at the site root, containing the key as plain text.
//   3. Verify — we HEAD/GET {domain}/{key}.txt and confirm the body matches the key.
//   4. Subsequent URL submissions (via /search/submit-url) use the key and the hosted
//      file location as proof of ownership.

// --- GET /arion/search/indexnow?siteId= — key status ---
router.get('/search/indexnow', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const key = site.indexnow_key || null;
    const generatedAt = site.indexnow_generated_at || null;
    const verifiedAt = site.indexnow_verified_at || null;
    const keyLocation = key ? `https://${site.domain}/${key}.txt` : null;
    res.json({
      key,
      generatedAt,
      verifiedAt,
      verified: !!verifiedAt,
      keyLocation,
      keyFileContents: key,
      host: site.domain,
    });
  } catch (err) {
    console.error('[arion/search/indexnow GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/search/indexnow/generate-key — generate, install, verify in one shot ---
// End-to-end enablement: generates a key, stores it, installs it on the WP site via the IA
// Plugin's /indexnow-key endpoint (admin Basic auth using wp_app_password_ref), then fetches
// {domain}/{key}.txt to confirm hosting and marks the site verified. The client just clicks
// one button — no file upload or manual config required.
router.post('/search/indexnow/generate-key', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const key = crypto.randomUUID().replace(/-/g, '');
    const now = new Date();
    const keyLocation = `https://${site.domain}/${key}.txt`;

    // 1. Store in DB (verified=false initially)
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('key', sql.NVarChar(64), key)
      .input('now', sql.DateTime2, now)
      .query(`UPDATE arion.site
              SET indexnow_key = @key, indexnow_generated_at = @now, indexnow_verified_at = NULL
              WHERE tenant_id = @tenantId AND site_id = @siteId`);

    // 2. Auto-install via IA Plugin (if app password is configured)
    let installed = false;
    let installError = null;
    const appPwRef = site.wp_app_password_ref;
    if (appPwRef) {
      try {
        const pluginRes = await fetch(`https://${site.domain}/wp-json/intelligent-analytics/v1/indexnow-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(appPwRef).toString('base64'),
          },
          body: JSON.stringify({ key }),
          signal: AbortSignal.timeout(15_000),
        });
        if (pluginRes.ok) {
          installed = true;
        } else {
          const text = await pluginRes.text().catch(() => '');
          installError = `Plugin install returned ${pluginRes.status}: ${text.slice(0, 200)}`;
        }
      } catch (e) {
        installError = `Plugin install failed: ${e.message}`;
      }
    } else {
      installError = 'WP application password not configured for this site';
    }

    // 3. Auto-verify by fetching the key file
    let verified = false;
    let verifyError = null;
    let verifyStatus = null;
    if (installed) {
      try {
        // Small delay for any caching to settle
        await new Promise(r => setTimeout(r, 1000));
        const vr = await fetch(keyLocation, { method: 'GET', signal: AbortSignal.timeout(10_000) });
        verifyStatus = vr.status;
        const body = (await vr.text().catch(() => '')).trim();
        if (vr.ok && body === key) {
          verified = true;
          await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('siteId', sql.UniqueIdentifier, siteId)
            .input('now', sql.DateTime2, new Date())
            .query('UPDATE arion.site SET indexnow_verified_at = @now WHERE tenant_id = @tenantId AND site_id = @siteId');
        } else {
          verifyError = vr.ok
            ? `Key file served, but content did not match. Got "${body.slice(0, 60)}".`
            : `Key file not reachable: HTTP ${vr.status}`;
        }
      } catch (e) {
        verifyError = `Verification fetch failed: ${e.message}`;
      }
    }

    res.json({
      key,
      keyLocation,
      keyFileContents: key,
      host: site.domain,
      generatedAt: now.toISOString(),
      installed,
      installError,
      verified,
      verifiedAt: verified ? new Date().toISOString() : null,
      verifyError,
      verifyStatus,
      // If install+verify both succeeded, the client is fully enabled and the UI can
      // show a single "Active" state. If either failed, fall back to manual instructions.
      autoEnabled: installed && verified,
    });
  } catch (err) {
    console.error('[arion/search/indexnow/generate-key]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/search/indexnow/verify — confirm {key}.txt is hosted at site root ---
// Fetches https://{domain}/{key}.txt and confirms the response body equals the stored key.
// Marks indexnow_verified_at on success. Returns the HTTP status and body excerpt on failure.
router.post('/search/indexnow/verify', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const key = site.indexnow_key;
    if (!key) return res.status(400).json({ error: { code: 'NO_KEY', message: 'No IndexNow key generated for this site yet', status: 400 } });
    const keyLocation = `https://${site.domain}/${key}.txt`;
    let status, bodyText = '', verified = false, errorMessage = null;
    try {
      const fetchRes = await fetch(keyLocation, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      status = fetchRes.status;
      bodyText = (await fetchRes.text().catch(() => '')).trim();
      if (fetchRes.ok) {
        if (bodyText === key) {
          verified = true;
        } else {
          errorMessage = `File fetched but content does not match the key. Expected "${key}" but got "${bodyText.slice(0, 100)}".`;
        }
      } else {
        errorMessage = `Key file not reachable — HTTP ${status}. Confirm the file is hosted at ${keyLocation} and publicly accessible.`;
      }
    } catch (e) {
      errorMessage = `Network error while fetching key file: ${e.message}. Confirm ${keyLocation} is reachable.`;
    }
    if (verified) {
      const now = new Date();
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('now', sql.DateTime2, now)
        .query('UPDATE arion.site SET indexnow_verified_at = @now WHERE tenant_id = @tenantId AND site_id = @siteId');
      res.json({ verified: true, verifiedAt: now.toISOString(), keyLocation, status });
    } else {
      res.json({ verified: false, error: errorMessage, keyLocation, status, bodyExcerpt: bodyText.slice(0, 200) });
    }
  } catch (err) {
    console.error('[arion/search/indexnow/verify]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- DELETE /arion/search/indexnow?siteId= — remove the key ---
router.delete('/search/indexnow', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    // Best-effort: ask the plugin to stop serving the key file too
    const appPwRef = site.wp_app_password_ref;
    if (appPwRef) {
      fetch(`https://${site.domain}/wp-json/intelligent-analytics/v1/indexnow-key`, {
        method: 'DELETE',
        headers: { Authorization: 'Basic ' + Buffer.from(appPwRef).toString('base64') },
        signal: AbortSignal.timeout(10_000),
      }).catch(e => console.warn('[arion/search/indexnow DELETE] plugin cleanup failed:', e.message));
    }
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('UPDATE arion.site SET indexnow_key = NULL, indexnow_generated_at = NULL, indexnow_verified_at = NULL WHERE tenant_id = @tenantId AND site_id = @siteId');
    res.json({ deleted: true });
  } catch (err) {
    console.error('[arion/search/indexnow DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/search/indexnow/submissions?siteId=&limit=20 — recent submission log ---
router.get('/search/indexnow/submissions', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('limit', sql.Int, limit)
      .query(`SELECT TOP (@limit) submission_id, submitted_url, submitted_at, status, response_code
              FROM arion.indexnow_submission
              WHERE tenant_id = @tenantId AND site_id = @siteId
              ORDER BY submitted_at DESC`);
    res.json({
      submissions: (r.recordset || []).map(row => ({
        submissionId: row.submission_id,
        url: row.submitted_url,
        submittedAt: row.submitted_at,
        status: row.status,
        responseCode: row.response_code,
      })),
    });
  } catch (err) {
    // If migration 006 hasn't run yet, the table won't exist — return empty list gracefully
    if (err && String(err.message).includes('Invalid object name')) {
      return res.json({ submissions: [], migrationPending: true });
    }
    console.error('[arion/search/indexnow/submissions]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/search/sitemaps?siteId=&provider=google|bing ---
router.get('/search/sitemaps', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = (req.query.provider || 'google').toLowerCase();
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    let sitemaps = [];

    if (provider === 'google') {
      const refreshToken = site.gbp_oauth_token_ref;
      if (!refreshToken) return res.json({ provider, sitemaps: [], error: 'Google not connected' });
      const tokenData = await getAccessToken(refreshToken).catch(() => null);
      if (!tokenData) return res.json({ provider, sitemaps: [], error: 'Failed to get access token' });
      const resolvedProperty = await resolveGscProperty(tokenData.access_token, site.domain);
      const siteUrl = encodeURIComponent(resolvedProperty);
      try {
        const apiRes = await fetch('https://www.googleapis.com/webmasters/v3/sites/' + siteUrl + '/sitemaps', {
          headers: { Authorization: 'Bearer ' + tokenData.access_token },
        });
        if (apiRes.ok) {
          const data = await apiRes.json();
          sitemaps = (data.sitemap || []).map(s => ({
            url: s.path || '', type: s.type || null, lastSubmitted: s.lastSubmitted || null,
            isPending: s.isPending || false, isSitemapsIndex: s.isSitemapsIndex || false,
            warnings: s.warnings || 0, errors: s.errors || 0,
          }));
        } else {
          console.warn('[arion/search/sitemaps] Google API error:', apiRes.status);
        }
      } catch (e) {
        console.warn('[arion/search/sitemaps] Google API call failed:', e.message);
      }
    } else if (provider === 'bing') {
      const bingKey = getBingKeyForSite(site);
      if (!bingKey) return res.json({ provider, sitemaps: [], error: 'Bing not connected for this site' });
      const siteUrl = site.bing_site_url || ('https://' + site.domain);
      try {
        const data = await bingGetSitemaps(bingKey, siteUrl);
        if (data && Array.isArray(data)) {
          sitemaps = data.map(s => ({
            url: s.Url || '', type: s.SitemapType || null, lastSubmitted: s.LastSubmittedDate || null,
            status: s.Status || null, urlCount: s.UrlCount ?? null, errorCount: s.ErrorCount ?? null,
          }));
        }
      } catch (e) {
        console.warn('[arion/search/sitemaps] Bing API call failed:', e.message);
      }
    } else {
      return res.status(400).json({ error: { code: 'INVALID_PROVIDER', message: 'provider must be google or bing', status: 400 } });
    }

    res.json({ provider, sitemaps });
  } catch (err) {
    console.error('[arion/search/sitemaps]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Bing Webmaster Tools — Phase 2
// ---------------------------------------------------------------------------
// Per-site API key stored in arion.site.bing_api_key (set by POST /arion/bing/verify).
// All Bing callers prefer the per-site key, falling back to process.env.BING_WMT_API_KEY
// so existing env-var-based flows keep working when a site hasn't connected yet.
function getBingKeyForSite(site) {
  return site?.bing_api_key || process.env.BING_WMT_API_KEY || null;
}

// --- POST /arion/bing/verify?siteId= — verify a Bing WMT API key and store it ---
router.post('/bing/verify', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  const { apiKey, siteUrl } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'apiKey required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const host = site.domain;
    const verification = await bingVerifyKey(apiKey.trim(), host);
    if (!verification.valid) {
      return res.json({ verified: false, error: verification.error, detail: verification.body || null });
    }
    // Decide which Bing siteUrl to store. Prefer the matched one, else the provided siteUrl,
    // else construct https://<domain>/
    const resolvedSiteUrl = verification.siteMatches?.Url || verification.siteMatches?.url || siteUrl || ('https://' + host + '/');
    const matched = !!verification.siteMatches;
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('key', sql.NVarChar(200), apiKey.trim())
      .input('siteUrl', sql.NVarChar(300), resolvedSiteUrl)
      .input('now', sql.DateTime2, new Date())
      .query(`UPDATE arion.site
              SET bing_api_key = @key, bing_site_url = @siteUrl, bing_connected = 1, bing_connected_at = @now
              WHERE tenant_id = @tenantId AND site_id = @siteId`);
    res.json({
      verified: true,
      matchedSite: matched,
      siteUrl: resolvedSiteUrl,
      siteCount: verification.sites?.length || 0,
      warning: matched ? null : `Key is valid but none of the ${verification.sites?.length || 0} registered sites match "${host}". Add ${host} in Bing Webmaster Tools before live data will flow.`,
    });
  } catch (err) {
    console.error('[arion/bing/verify]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/bing/auto-connect?siteId= ---
// One-click agency-mode flow. Uses the master Bing account's API key (from
// BING_WMT_API_KEY env) to add the client's site under the master account,
// then writes a Bing verification CNAME via the Hostinger DNS API, polls until
// Bing marks the site verified, and persists the connection on the site row.
// Client-facing: no key paste, no copy-and-paste. Just Connect → Active.
router.post('/bing/auto-connect', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  const masterKey = process.env.BING_WMT_API_KEY;
  if (!masterKey) return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Bing master API key not configured', status: 503 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain', status: 400 } });

    const siteUrl = 'https://' + site.domain + '/';

    // Step 1: add the site to the master Bing account (idempotent)
    const addRes = await bingAddSite(masterKey, siteUrl);
    if (!addRes.ok) {
      return res.json({ connected: false, stage: 'add_site', error: addRes.error });
    }

    // Step 2: look up the site entry to get the per-site DnsVerificationCode
    let entry = await bingGetSiteEntry(masterKey, siteUrl);
    if (!entry) {
      // Sometimes Bing takes a moment after AddSite before the entry is visible — retry once
      await new Promise(r => setTimeout(r, 2000));
      entry = await bingGetSiteEntry(masterKey, siteUrl);
    }
    if (!entry) return res.json({ connected: false, stage: 'lookup', error: 'Site not found in master account after AddSite. Try again in a moment.' });

    // Short-circuit if already verified (re-connect case)
    if (entry.IsVerified) {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('siteUrl', sql.NVarChar(300), entry.Url || siteUrl)
        .input('now', sql.DateTime2, new Date())
        .query(`UPDATE arion.site
                SET bing_api_key = NULL, bing_site_url = @siteUrl, bing_connected = 1, bing_connected_at = @now
                WHERE tenant_id = @tenantId AND site_id = @siteId`);
      return res.json({ connected: true, alreadyVerified: true, siteUrl: entry.Url || siteUrl });
    }

    // Step 3: parse the DNS verification code. Bing returns it as "<hex>.<domain>".
    // We split that into { subdomain, host } so Hostinger's DNS API can add the CNAME.
    const dnsCode = entry.DnsVerificationCode || '';
    const dotIdx = dnsCode.indexOf('.');
    const subdomain = dotIdx > 0 ? dnsCode.slice(0, dotIdx) : dnsCode;
    if (!subdomain) return res.json({ connected: false, stage: 'parse_code', error: 'Bing did not return a DnsVerificationCode' });

    // Step 4: write the CNAME via Hostinger DNS API
    let dnsResult = null;
    try {
      dnsResult = await createDnsRecords(site.domain, [{ type: 'CNAME', name: subdomain, content: 'verify.bing.com' }], false);
    } catch (e) {
      return res.json({ connected: false, stage: 'dns_write', error: e.message, dnsRecordNeeded: { type: 'CNAME', name: subdomain, content: 'verify.bing.com' } });
    }
    if (!dnsResult) {
      return res.json({ connected: false, stage: 'dns_write', error: 'Hostinger DNS API returned no result', dnsRecordNeeded: { type: 'CNAME', name: subdomain, content: 'verify.bing.com' } });
    }

    // Step 5: poll Bing until IsVerified flips (up to ~2 min). Bing itself
    // handles the verification check periodically; we just watch for the flag.
    const poll = await bingPollUntilVerified(masterKey, siteUrl, { maxAttempts: 12, delayMs: 10_000 });
    if (!poll.verified) {
      return res.json({
        connected: false,
        stage: 'verify_timeout',
        error: 'DNS record written but Bing has not verified yet. It usually finishes within 10-15 minutes — check back and click Connect again, or use the manual option if it does not.',
        dnsRecordWritten: { type: 'CNAME', name: subdomain, content: 'verify.bing.com' },
      });
    }

    // Step 6: persist the connection
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('siteUrl', sql.NVarChar(300), poll.entry?.Url || siteUrl)
      .input('now', sql.DateTime2, new Date())
      .query(`UPDATE arion.site
              SET bing_api_key = NULL, bing_site_url = @siteUrl, bing_connected = 1, bing_connected_at = @now
              WHERE tenant_id = @tenantId AND site_id = @siteId`);

    res.json({ connected: true, siteUrl: poll.entry?.Url || siteUrl, dnsRecord: { type: 'CNAME', name: subdomain, content: 'verify.bing.com' } });
  } catch (err) {
    console.error('[arion/bing/auto-connect]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/bing/status?siteId= ---
router.get('/bing/status', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    res.json({
      connected: !!site.bing_connected && !!site.bing_api_key,
      siteUrl: site.bing_site_url || null,
      connectedAt: site.bing_connected_at || null,
      usingFallbackKey: !site.bing_api_key && !!process.env.BING_WMT_API_KEY,
    });
  } catch (err) {
    console.error('[arion/bing/status]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/bing/disconnect?siteId= ---
router.post('/bing/disconnect', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`UPDATE arion.site SET bing_api_key = NULL, bing_site_url = NULL, bing_connected = 0, bing_connected_at = NULL
              WHERE tenant_id = @tenantId AND site_id = @siteId`);
    res.json({ disconnected: true });
  } catch (err) {
    console.error('[arion/bing/disconnect]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/bing/performance?siteId=&period=30|90 ---
router.get('/bing/performance', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const period = [30, 90, 365].includes(parseInt(req.query.period, 10)) ? parseInt(req.query.period, 10) : 30;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const key = getBingKeyForSite(site);
    if (!key) return res.json({ connected: false, period, summary: null, dailyBreakdown: [] });
    const bingSiteUrl = site.bing_site_url || ('https://' + site.domain);
    const data = await bingGetRankAndTrafficStats(key, bingSiteUrl, period);
    if (!data) return res.json({ connected: true, period, error: 'no_data', summary: null, dailyBreakdown: [] });
    res.json({ connected: true, period, summary: data.summary, dailyBreakdown: data.dailyBreakdown });
  } catch (err) {
    console.error('[arion/bing/performance]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/bing/queries?siteId=&period=30|90 ---
router.get('/bing/queries', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const key = getBingKeyForSite(site);
    if (!key) return res.json({ connected: false, queries: [] });
    const bingSiteUrl = site.bing_site_url || ('https://' + site.domain);
    const queries = await bingGetKeywordStats(key, bingSiteUrl, 25);
    res.json({ connected: true, queries: queries || [] });
  } catch (err) {
    console.error('[arion/bing/queries]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/search/bing/stats?siteId= — crawl stats + submission quota ---
// Surfaces the meaningful Bing data that Google doesn't expose publicly:
// crawl activity (200s/301s/404s/500s/robots.txt hits) and URL submission quota.
router.get('/search/bing/stats', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const bingKey = getBingKeyForSite(site);
    if (!bingKey) return res.json({ connected: false, error: 'Bing Webmaster Tools not connected' });
    const siteUrl = site.bing_site_url || ('https://' + site.domain);
    const [crawl, quota] = await Promise.all([
      bingGetCrawlStats(bingKey, siteUrl).catch(() => null),
      bingGetUrlSubmissionQuota(bingKey, siteUrl).catch(() => null),
    ]);

    // Crawl stats: Bing returns an array of daily rows. Sum recent activity for summary.
    let crawlSummary = null;
    const crawlRows = crawl?.d || crawl || [];
    if (Array.isArray(crawlRows) && crawlRows.length > 0) {
      const recent = crawlRows.slice(0, 30);
      crawlSummary = {
        days: recent.length,
        totalCrawled: recent.reduce((s, r) => s + (r.CrawledPages || r.Total || 0), 0),
        http2xx: recent.reduce((s, r) => s + (r.Http2xx || 0), 0),
        http301: recent.reduce((s, r) => s + (r.Http301 || 0), 0),
        http404: recent.reduce((s, r) => s + (r.Http404 || 0), 0),
        http5xx: recent.reduce((s, r) => s + (r.Http5xx || 0), 0),
        robotsDenied: recent.reduce((s, r) => s + (r.RobotsTxtHits || 0), 0),
        malwareDetected: recent.reduce((s, r) => s + (r.Malware || 0), 0),
        dailySeries: recent.map(r => ({
          date: r.Date || r.date || null,
          crawled: r.CrawledPages || r.Total || 0,
          http2xx: r.Http2xx || 0,
          http404: r.Http404 || 0,
          http5xx: r.Http5xx || 0,
        })),
      };
    }

    // Quota: Bing returns counts of remaining daily/monthly URL submissions
    let quotaSummary = null;
    const quotaData = quota?.d || quota || null;
    if (quotaData && typeof quotaData === 'object') {
      quotaSummary = {
        dailyRemaining: quotaData.DailyQuota ?? null,
        monthlyRemaining: quotaData.MonthlyQuota ?? null,
      };
    }

    res.json({ connected: true, crawl: crawlSummary, quota: quotaSummary });
  } catch (err) {
    console.error('[arion/search/bing/stats]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/search/core-web-vitals?siteId= ---
router.get('/search/core-web-vitals', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    let metrics = { lcp: { p75: null, rating: null }, inp: { p75: null, rating: null }, cls: { p75: null, rating: null } };

    const cruxApiKey = process.env.CRUX_API_KEY || process.env.GOOGLE_CRUX_API_KEY;
    if (!cruxApiKey) return res.json({ metrics, error: 'CrUX API key not configured' });

    try {
      const apiRes = await fetch('https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=' + cruxApiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://' + site.domain }),
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const m = data.record?.metrics || {};
        if (m.largest_contentful_paint) {
          metrics.lcp = { p75: m.largest_contentful_paint.percentiles?.p75 ?? null, rating: m.largest_contentful_paint.category ?? null };
        }
        if (m.interaction_to_next_paint) {
          metrics.inp = { p75: m.interaction_to_next_paint.percentiles?.p75 ?? null, rating: m.interaction_to_next_paint.category ?? null };
        }
        if (m.cumulative_layout_shift) {
          metrics.cls = { p75: m.cumulative_layout_shift.percentiles?.p75 ?? null, rating: m.cumulative_layout_shift.category ?? null };
        }
      } else {
        const text = await apiRes.text().catch(() => '');
        console.warn('[arion/search/core-web-vitals] CrUX API error:', apiRes.status, text.slice(0, 200));
      }
    } catch (e) {
      console.warn('[arion/search/core-web-vitals] CrUX API call failed:', e.message);
    }

    res.json({ metrics });
  } catch (err) {
    console.error('[arion/search/core-web-vitals]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Business Routes — Google Business Profile (Phase 1)
// ---------------------------------------------------------------------------

// Helper: get the site row + resolved GBP location name. Persists the resolved
// name to arion.site.gbp_location_name on first resolution so subsequent calls skip
// the accounts→locations discovery round-trip.
async function getGbpContext(pool, tenantId, siteId) {
  const site = await getSiteForTenant(pool, tenantId, siteId);
  if (!site) return { error: 'site_not_found', status: 404 };
  if (!site.gbp_connected) return { error: 'not_connected', site };
  const refreshToken = site.gbp_oauth_token_ref;
  if (!refreshToken) return { error: 'not_connected', site };
  let locationName = site.gbp_location_name || null;
  if (!locationName) {
    const tokenData = await getAccessToken(refreshToken).catch(() => null);
    if (!tokenData) return { error: 'gbp_auth_expired', site };
    try {
      locationName = await resolveGbpLocationName(tokenData.access_token);
      if (locationName) {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('locationName', sql.NVarChar(200), locationName)
          .query('UPDATE arion.site SET gbp_location_name = @locationName WHERE tenant_id = @tenantId AND site_id = @siteId');
      }
    } catch (e) {
      console.warn('[gbp] resolveGbpLocationName failed:', e.message);
      // Surface quota / disabled errors specifically — these are operator actions,
      // not a missing-location issue
      if (e.code === 'gbp_quota_exceeded') return { error: 'gbp_quota_exceeded', site };
      if (e.code === 'gbp_api_disabled') return { error: 'gbp_api_disabled', site };
    }
    if (!locationName) return { error: 'location_not_found', site };
  }
  return { site, refreshToken, locationName };
}

// --- GET /arion/business?siteId= ---
// Live GBP profile + 30-day performance metrics.
router.get('/business', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error === 'not_connected') return res.json({ connected: false, error: 'not_connected' });
    if (ctx.error === 'gbp_auth_expired') return res.json({ connected: true, error: 'gbp_auth_expired' });
    if (ctx.error === 'location_not_found') return res.json({ connected: true, error: 'location_not_found' });

    // Parallel: fetch business info + performance metrics
    const [infoRes, perfRes] = await Promise.all([
      gbpFetchInfo(ctx.refreshToken, ctx.locationName),
      gbpFetchPerformance(ctx.refreshToken, ctx.locationName, 30),
    ]);

    if (infoRes?.error) {
      return res.json({ connected: true, error: infoRes.error });
    }

    const loc = infoRes.location;
    const business = {
      name: loc.title || null,
      phone: loc.phoneNumbers?.primaryPhone || null,
      address: gbpFormatAddress(loc.storefrontAddress), // null-or-string, never "null" text
      website: loc.websiteUri || null,
      primaryCategory: loc.categories?.primaryCategory?.displayName || null,
      description: loc.profile?.description || null,
      regularHours: loc.regularHours || null,
      specialHours: loc.specialHours || null,
      locationName: infoRes.locationName,
    };

    let metrics = null, dailyBreakdown = [];
    if (perfRes && !perfRes.error && perfRes.data) {
      const sum = gbpSummarizePerf(perfRes.data);
      metrics = {
        impressions: sum.impressions,
        impressionsDesktopMaps: sum.impressionsDesktopMaps,
        impressionsDesktopSearch: sum.impressionsDesktopSearch,
        impressionsMobileMaps: sum.impressionsMobileMaps,
        impressionsMobileSearch: sum.impressionsMobileSearch,
        calls: sum.calls,
        websiteClicks: sum.websiteClicks,
        directionsRequests: sum.directionsRequests,
        conversations: sum.conversations,
        bookings: sum.bookings,
      };
      dailyBreakdown = sum.dailyBreakdown;
    }

    res.json({ connected: true, business, metrics, dailyBreakdown });
  } catch (err) {
    console.error('[arion/business]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/business/reviews?siteId= ---
router.get('/business/reviews', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.json({ connected: !['not_connected','site_not_found'].includes(ctx.error), error: ctx.error });
    const r = await gbpFetchReviews(ctx.refreshToken, ctx.locationName);
    if (r?.error) return res.json({ connected: true, error: r.error, totalReviewCount: 0, averageRating: 0, reviews: [] });
    res.json({ connected: true, totalReviewCount: r.totalReviewCount, averageRating: r.averageRating, reviews: r.reviews });
  } catch (err) {
    console.error('[arion/business/reviews]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/business/insights?siteId=&period=30|90 ---
router.get('/business/insights', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const period = [30, 90].includes(parseInt(req.query.period, 10)) ? parseInt(req.query.period, 10) : 30;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.json({ connected: !['not_connected','site_not_found'].includes(ctx.error), error: ctx.error });
    const perf = await gbpFetchPerformance(ctx.refreshToken, ctx.locationName, period);
    if (perf?.error) return res.json({ connected: true, error: perf.error, period });
    const sum = gbpSummarizePerf(perf.data);
    res.json({
      connected: true,
      period,
      totals: {
        impressions: sum.impressions,
        calls: sum.calls,
        websiteClicks: sum.websiteClicks,
        directionsRequests: sum.directionsRequests,
        conversations: sum.conversations,
        bookings: sum.bookings,
      },
      dailyBreakdown: sum.dailyBreakdown,
    });
  } catch (err) {
    console.error('[arion/business/insights]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/business/qanda?siteId= ---
router.get('/business/qanda', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.json({ connected: !['not_connected','site_not_found'].includes(ctx.error), error: ctx.error, questions: [] });
    const q = await gbpFetchQuestions(ctx.refreshToken, ctx.locationName);
    if (q?.error) return res.json({ connected: true, error: q.error, questions: [] });
    res.json({ connected: true, questions: q.questions });
  } catch (err) {
    console.error('[arion/business/qanda]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- PATCH /arion/business/update?siteId= ---
// Body: { name?, phone?, website?, description?, regularHours?, specialHours? }
router.patch('/business/update', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });

    const { name, phone, website, description, regularHours, specialHours } = req.body || {};
    const updates = {};
    const maskParts = [];
    if (name !== undefined) { updates.title = name; maskParts.push('title'); }
    if (phone !== undefined) { updates.phoneNumbers = { primaryPhone: phone }; maskParts.push('phoneNumbers.primaryPhone'); }
    if (website !== undefined) { updates.websiteUri = website; maskParts.push('websiteUri'); }
    if (description !== undefined) { updates.profile = { description }; maskParts.push('profile.description'); }
    if (regularHours !== undefined) { updates.regularHours = regularHours; maskParts.push('regularHours'); }
    if (specialHours !== undefined) { updates.specialHours = specialHours; maskParts.push('specialHours'); }
    if (maskParts.length === 0) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update', status: 400 } });

    const r = await gbpPatchInfo(ctx.refreshToken, ctx.locationName, maskParts.join(','), updates);
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true, location: r.location });
  } catch (err) {
    console.error('[arion/business/update]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/business/reviews/:reviewId/reply?siteId= ---
router.post('/business/reviews/:reviewId/reply', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const reviewId = req.params.reviewId;
  const { comment } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!comment || !comment.trim()) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'comment required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });
    const r = await gbpReplyToReview(ctx.refreshToken, ctx.locationName, reviewId, comment.trim());
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true, reply: r.reply });
  } catch (err) {
    console.error('[arion/business/reviews/reply]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- DELETE /arion/business/reviews/:reviewId/reply?siteId= ---
router.delete('/business/reviews/:reviewId/reply', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const reviewId = req.params.reviewId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });
    const r = await gbpDeleteReviewReply(ctx.refreshToken, ctx.locationName, reviewId);
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[arion/business/reviews/reply:delete]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/business/posts/create?siteId= ---
router.post('/business/posts/create', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });
    const r = await gbpCreateLocalPost(ctx.refreshToken, ctx.locationName, req.body || {});
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true, post: r.post });
  } catch (err) {
    console.error('[arion/business/posts/create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- DELETE /arion/business/posts/:postId?siteId= ---
router.delete('/business/posts/:postId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const postId = req.params.postId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });
    const r = await gbpDeleteLocalPost(ctx.refreshToken, ctx.locationName, postId);
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[arion/business/posts/delete]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/business/qanda/:questionId/answer?siteId= ---
router.post('/business/qanda/:questionId/answer', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const questionId = req.params.questionId;
  const { text } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!text || !text.trim()) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'text required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.status(400).json({ error: { code: ctx.error.toUpperCase(), message: ctx.error, status: 400 } });
    const r = await gbpAnswerQuestion(ctx.refreshToken, ctx.locationName, questionId, text.trim());
    if (r.error) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: r.error, status: 502 } });
    res.json({ ok: true, answer: r.answer });
  } catch (err) {
    console.error('[arion/business/qanda/answer]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/business/overview?siteId=&provider=google|bing|apple ---
router.get('/business/overview', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = (req.query.provider || 'google').toLowerCase();
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    let connected = false;
    if (provider === 'google') connected = site.gbp_connected ? true : false;
    else if (provider === 'apple') connected = site.apple_claimed ? true : false;

    let profile = nullProfile(connected);

    if (provider === 'google' && connected) {
      try {
        const gbpRes = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId');
        const row = gbpRes.recordset[0];
        if (row) {
          profile = { connected: true, editable: true, displayName: row.business_name || null, primaryCategory: row.categories || null, websiteUrl: row.website || null, mapsUrl: null, phone: row.phone || null, address: row.address || null, hours: row.hours || null, resourceUrl: null, integration: null };
        }
      } catch (e) { console.warn('[arion/business/overview] gbp_profile query failed:', e.message); }
    }

    res.json({ site: toSiteSummary(site), provider, profile });
  } catch (err) {
    console.error('[arion/business/overview]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/business/posts?siteId= ---  (Phase 1: live API)
router.get('/business/posts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const ctx = await getGbpContext(pool, tenantId, siteId);
    if (ctx.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (ctx.error) return res.json({ connected: !['not_connected','site_not_found'].includes(ctx.error), error: ctx.error, posts: [] });
    const r = await gbpFetchLocalPosts(ctx.refreshToken, ctx.locationName);
    if (r?.error) return res.json({ connected: true, error: r.error, posts: [] });
    res.json({ connected: true, posts: r.posts });
  } catch (err) {
    console.error('[arion/business/posts]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/business/posts?siteId= ---  (alias for /business/posts/create — kept for backward compat)
router.post('/business/posts', async (req, res) => {
  // Forward to the /create handler via direct call so we don't duplicate logic
  req.url = req.url.replace('/business/posts', '/business/posts/create');
  router.handle(req, res);
});

// --- GET /arion/business/services?siteId= ---
router.get('/business/services', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    res.json({ services: [] });
  } catch (err) {
    console.error('[arion/business/services]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Analytics Route
// ---------------------------------------------------------------------------

// --- GET /arion/analytics/report?siteId=&type=monthly_summary ---
router.get('/analytics/report', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const type = req.query.type || 'monthly_summary';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const safeQuery = (promise) => promise.catch(e => { console.warn('[arion/analytics/report] sub-query failed:', e.message); return null; });

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const priorMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const priorMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

    const [currentForms, currentBookings, priorForms, priorBookings] = await Promise.all([
      safeQuery(pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('start', sql.Date, currentMonthStart)
        .query('SELECT COUNT(*) AS cnt FROM arion.site_form_submission WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= @start')),
      safeQuery(pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('start', sql.Date, currentMonthStart)
        .query('SELECT COUNT(*) AS cnt FROM arion.site_booking_request WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= @start')),
      safeQuery(pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('start', sql.Date, priorMonthStart)
        .input('end', sql.Date, priorMonthEnd)
        .query('SELECT COUNT(*) AS cnt FROM arion.site_form_submission WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= @start AND submitted_at <= @end')),
      safeQuery(pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, site.site_id)
        .input('start', sql.Date, priorMonthStart)
        .input('end', sql.Date, priorMonthEnd)
        .query('SELECT COUNT(*) AS cnt FROM arion.site_booking_request WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= @start AND submitted_at <= @end')),
    ]);

    res.json({
      type,
      current: {
        forms: currentForms?.recordset?.[0]?.cnt ?? 0,
        bookings: currentBookings?.recordset?.[0]?.cnt ?? 0,
        period: { start: currentMonthStart, end: now.toISOString().split('T')[0] },
      },
      prior: {
        forms: priorForms?.recordset?.[0]?.cnt ?? 0,
        bookings: priorBookings?.recordset?.[0]?.cnt ?? 0,
        period: { start: priorMonthStart, end: priorMonthEnd },
      },
    });
  } catch (err) {
    console.error('[arion/analytics/report]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/search/generate-sitemap ---
// Best-effort sitemap (re)submission. Strategy:
//   1. Ask GSC which sitemaps it already knows about for the verified property.
//   2. Auto-detect standard WP sitemap locations (sitemap_index.xml, sitemap.xml,
//      wp-sitemap.xml) with HEAD-then-GET fallback (Cloudflare blocks HEAD).
//   3. Union the two lists. Submit every URL in the union to Google (if connected)
//      and Bing (if key configured). Each per-URL result is returned so the UI can
//      show exactly what happened for each sitemap.
router.post('/search/generate-sitemap', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const domain = site.domain;
    if (!domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain configured', status: 400 } });

    const refreshToken = site.gbp_oauth_token_ref;
    let tokenData = null;
    if (refreshToken) tokenData = await getAccessToken(refreshToken).catch(() => null);

    // Resolve the exact verified property (sc-domain: or https://.../) so submit-sitemap
    // doesn't fail with "not part of this property"
    const siteUrl = tokenData?.access_token
      ? await resolveGscProperty(tokenData.access_token, domain)
      : 'https://' + domain;

    // 1. Existing GSC-registered sitemaps (authoritative — these are the URLs the client already submitted)
    let gscSitemapUrls = [];
    if (tokenData?.access_token) {
      const existing = await listGoogleSitemaps(tokenData.access_token, siteUrl);
      gscSitemapUrls = existing.map(s => s.path).filter(Boolean);
    }

    // 2. Auto-detect standard locations
    const detectedUrl = await detectSitemapUrl(domain);

    // 3. Union + dedupe
    const allSitemaps = [...new Set([...(gscSitemapUrls || []), ...(detectedUrl ? [detectedUrl] : [])])];

    // 4. WP URL count (informational)
    let wpUrls = [];
    try {
      wpUrls = await fetchWordPressPages(domain);
    } catch (err) {
      console.warn('[arion/search/generate-sitemap] WP REST API crawl failed:', err.message);
    }

    // 5. Submit each sitemap to Google and Bing (Bing: per-site key -> env fallback)
    const bingKey = getBingKeyForSite(site);
    const results = [];
    const submittedTo = new Set();

    // Helper: humanize a raw submitToGoogle error message
    const humanizeGoogleError = (raw) => {
      if (!raw) return 'Google sitemap submission failed';
      if (/insufficient authentication scopes|insufficient permission/i.test(raw)) {
        return 'Google is connected with read-only scope. Reconnect Google Search Console in Settings → Connected Accounts to grant sitemap-write permission.';
      }
      if (/not part of this property|do not own this site/i.test(raw)) {
        return `The sitemap URL is not inside the verified Search Console property (${siteUrl}). Add the correct property in GSC or use the matching sitemap URL.`;
      }
      // Strip the long stack prefix ("HTTP 403: {...}") down to the core message
      const cleaned = raw.replace(/^HTTP \d+:\s*/, '');
      try {
        const parsed = JSON.parse(cleaned);
        return parsed?.error?.message || cleaned.slice(0, 240);
      } catch {
        return cleaned.slice(0, 240);
      }
    };

    for (const sm of allSitemaps) {
      const perMap = { sitemapUrl: sm, google: null, bing: null };
      if (tokenData?.access_token) {
        const g = await submitToGoogle(tokenData.access_token, siteUrl, sm);
        perMap.google = g.submitted ? g : { submitted: false, error: humanizeGoogleError(g.error) };
        if (perMap.google.submitted) submittedTo.add('google');
      } else {
        perMap.google = { submitted: false, error: 'Google Search Console not connected for this site' };
      }
      if (bingKey) {
        const b = await submitToBing(bingKey, siteUrl, sm);
        if (b.submitted) {
          perMap.bing = b;
          submittedTo.add('bing');
        } else {
          // Translate common Bing WMT errors (incl. HTML error pages) to plain English
          const raw = (b.error || '').replace(/^HTTP \d+:\s*/, '').trim();
          let friendly;
          if (raw.startsWith('<')) friendly = 'Bing returned an HTML error page — the site may not be registered in Bing Webmaster Tools for this API key, or the endpoint is refusing the request from this IP.';
          else if (/InvalidApiKey/i.test(raw)) friendly = 'Bing Webmaster Tools API key is invalid. Update BING_WMT_API_KEY in Azure App Service and restart, or reconnect Bing in Settings → Connected Accounts once the Bing connection flow ships.';
          else if (/NotFound|SiteNotFound/i.test(raw)) friendly = 'Site is not registered in Bing Webmaster Tools. Add the site in the Bing Webmaster dashboard first.';
          else if (/Unauthorized/i.test(raw)) friendly = 'Bing rejected the request as unauthorized. Verify the API key has permission for this site.';
          else {
            try { friendly = JSON.parse(raw)?.Message || raw.slice(0, 240); } catch { friendly = raw.slice(0, 240); }
          }
          perMap.bing = { submitted: false, error: friendly || 'Bing sitemap submission failed' };
        }
      } else {
        perMap.bing = { submitted: false, error: 'Bing Webmaster Tools not connected' };
      }
      results.push(perMap);
    }

    res.json({
      urls: wpUrls.length,
      sitemapUrl: detectedUrl || null,
      sitemapDetected: !!detectedUrl,
      sitemaps: allSitemaps,
      results,
      submittedTo: Array.from(submittedTo),
      googleConnected: !!tokenData?.access_token,
      bingConnected: !!bingKey,
    });
  } catch (err) {
    console.error('[arion/search/generate-sitemap]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/hosting/dns?siteId= — Create/update DNS records (Pro+ tier) ---
router.post('/hosting/dns', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  const { records } = req.body;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'records array is required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!meetsMinTier(site.arion_tier, 'pro')) {
      return res.status(402).json({ error: { code: 'TIER_LIMIT_REACHED', message: 'This feature requires pro tier or above', status: 402, upgrade: { current_tier: site.arion_tier, required_tier: 'pro' } } });
    }
    if (!site.domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain configured', status: 400 } });

    const result = await createDnsRecords(site.domain, records, false);
    if (!result) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to create DNS records', status: 502 } });

    res.json({ domain: site.domain, result });
  } catch (err) {
    console.error('[arion/hosting/dns POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- DELETE /arion/hosting/dns?siteId= — Delete DNS records (Pro+ tier) ---
router.delete('/hosting/dns', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  const { records } = req.body;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'records array is required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!meetsMinTier(site.arion_tier, 'pro')) {
      return res.status(402).json({ error: { code: 'TIER_LIMIT_REACHED', message: 'This feature requires pro tier or above', status: 402, upgrade: { current_tier: site.arion_tier, required_tier: 'pro' } } });
    }
    if (!site.domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain configured', status: 400 } });

    const result = await deleteDnsRecords(site.domain, records);
    if (!result) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Failed to delete DNS records', status: 502 } });

    res.json({ domain: site.domain, result });
  } catch (err) {
    console.error('[arion/hosting/dns DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/hosting/pagespeed?siteId= — Run PageSpeed test ---
router.post('/hosting/pagespeed', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain configured', status: 400 } });

    const testUrl = 'https://' + site.domain;
    const { strategy } = req.body || {};

    let desktop = null;
    let mobile = null;

    if (!strategy || strategy === 'desktop') {
      desktop = await runPageSpeedTest(testUrl, 'desktop');
    }
    if (!strategy || strategy === 'mobile') {
      mobile = await runPageSpeedTest(testUrl, 'mobile');
    }

    res.json({ desktop, mobile });
  } catch (err) {
    console.error('[arion/hosting/pagespeed POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/hosting/pagespeed?siteId= — Get PageSpeed results (runs live for now) ---
router.get('/hosting/pagespeed', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId query param required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.domain) return res.status(400).json({ error: { code: 'NO_DOMAIN', message: 'Site has no domain configured', status: 400 } });

    const testUrl = 'https://' + site.domain;
    const [desktop, mobile] = await Promise.all([
      runPageSpeedTest(testUrl, 'desktop'),
      runPageSpeedTest(testUrl, 'mobile'),
    ]);

    res.json({ desktop, mobile });
  } catch (err) {
    console.error('[arion/hosting/pagespeed GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/sites/:siteId/consulting-inquiry ---
router.post('/sites/:siteId/consulting-inquiry', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { service_type, description, contact_pref, trigger_page } = req.body;
  if (!service_type) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'service_type required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const inquiryId = crypto.randomUUID();
    await pool.request()
      .input('inquiryId', sql.UniqueIdentifier, inquiryId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('serviceType', sql.NVarChar(100), service_type)
      .input('description', sql.NVarChar(sql.MAX), description || null)
      .input('contactPref', sql.NVarChar(30), contact_pref || 'email')
      .input('arionTier', sql.NVarChar(20), site.arion_tier)
      .input('seoAddon', sql.NVarChar(20), site.seo_addon_tier || null)
      .input('triggerPage', sql.NVarChar(200), trigger_page || null)
      .query(`INSERT INTO arion.consulting_inquiry
        (inquiry_id,tenant_id,site_id,service_type,description,contact_pref,arion_tier,seo_addon,trigger_page)
        VALUES(@inquiryId,@tenantId,@siteId,@serviceType,@description,@contactPref,@arionTier,@seoAddon,@triggerPage)`);
    await firePlatformEvent(pool, { tenantId, eventType: 'arion.consulting.inquiry_created',
      eventRefId: inquiryId, payload: { inquiry_id: inquiryId, site_id: siteId, service_type, arion_tier: site.arion_tier } });
    res.json({ data: { inquiry_id: inquiryId }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[consulting-inquiry]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/sites/:siteId/content-seo ---
router.get('/sites/:siteId/content-seo', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.wp_admin_url) return res.status(409).json({ error: { code: 'NOT_READY', message: 'Site not provisioned', status: 409 } });

    const domain = site.domain || site.wp_admin_url.replace(/https?:\/\//, '').replace(/\/$/, '');
    const appPwRef = site.wp_app_password_ref;

    const wpBase = `https://${domain}/wp-json/wp/v2`;
    const headers = appPwRef
      ? { Authorization: 'Basic ' + Buffer.from(appPwRef).toString('base64') }
      : {};

    const [pagesRes, postsRes] = await Promise.all([
      fetch(`${wpBase}/pages?per_page=50&_fields=id,slug,link,title,modified`, { headers }).then(r => r.json()).catch(() => []),
      fetch(`${wpBase}/posts?per_page=50&_fields=id,slug,link,title,modified,status`, { headers }).then(r => r.json()).catch(() => []),
    ]);

    const enrichItem = async (item, type) => {
      try {
        const url = item.link || `https://${domain}/${item.slug}`;
        const head = await fetch(`https://${domain}/wp-json/rankmath/v1/getHead?url=${encodeURIComponent(url)}`)
          .then(r => r.json()).catch(() => null);
        const score = head?.head ? parseInt((head.head.match(/content="(\d+)\/100"/) || [])[1] || '0') : null;
        const metaTitle = head?.head?.match(/<title>([^<]*)<\/title>/)?.[1] || null;
        const metaDesc = head?.head?.match(/name="description" content="([^"]*)"/)?.[1] || null;
        return {
          id: item.id, type, title: item.title?.rendered || item.title || '--',
          url: item.link, slug: item.slug, modified: item.modified,
          seo_score: score, meta_title: metaTitle, meta_title_length: metaTitle?.length || 0,
          meta_desc: metaDesc, meta_desc_length: metaDesc?.length || 0,
          focus_keyword: null, robots: 'index,follow', schema_type: null,
        };
      } catch { return { id: item.id, type, title: item.title?.rendered || '--', seo_score: null }; }
    };

    const [pages, posts] = await Promise.all([
      Promise.all((Array.isArray(pagesRes) ? pagesRes : []).map(p => enrichItem(p, 'page'))),
      Promise.all((Array.isArray(postsRes) ? postsRes : []).map(p => enrichItem(p, 'post'))),
    ]);

    const all = [...pages, ...posts];
    const scored = all.filter(i => i.seo_score != null);
    const avgScore = scored.length ? Math.round(scored.reduce((s, i) => s + i.seo_score, 0) / scored.length) : 0;
    res.json({ data: { pages, posts, summary: { avg_score: avgScore,
      missing_meta: all.filter(i => !i.meta_desc).length,
      no_focus_keyword: all.filter(i => !i.focus_keyword).length,
      total: all.length } }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[content-seo]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- PUT /arion/sites/:siteId/content-seo/:postId (Pro+ tier) ---
router.put('/sites/:siteId/content-seo/:postId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, postId } = req.params;
  const { rank_math_title, rank_math_description, rank_math_focus_keyword } = req.body;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!meetsMinTier(site.arion_tier, 'pro'))
      return res.status(402).json({ error: { code: 'TIER_REQUIRED', message: 'Pro plan required for inline SEO editing', status: 402 } });
    const domain = site.domain;
    const appPwRef = site.wp_app_password_ref;
    if (!appPwRef) return res.status(409).json({ error: { code: 'NOT_CONFIGURED', message: 'WP Application Password not configured', status: 409 } });
    const meta = {};
    if (rank_math_title !== undefined) meta.rank_math_title = rank_math_title;
    if (rank_math_description !== undefined) meta.rank_math_description = rank_math_description;
    if (rank_math_focus_keyword !== undefined) meta.rank_math_focus_keyword = rank_math_focus_keyword;
    const wpRes = await fetch(`https://${domain}/wp-json/wp/v2/posts/${encodeURIComponent(postId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(appPwRef).toString('base64') },
      body: JSON.stringify({ meta }),
    });
    if (!wpRes.ok) throw new Error('WP REST API returned ' + wpRes.status);
    res.json({ data: { post_id: postId, updated: true }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[content-seo:put]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/sites/:siteId/vulnerabilities ---
router.get('/sites/:siteId/vulnerabilities', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const plugins = await getWpPlugins(site.domain).catch(() => []);
    const vulnRes = await fetch('https://www.wordfence.com/api/intelligence/v2/vulnerabilities/scanner/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: plugins.map(p => ({ slug: p.slug || p.name, version: p.version || '' })) })
    }).then(r => r.json()).catch(() => ({ vulnerabilities: [] }));
    const vulns = (vulnRes.vulnerabilities || []).map(v => ({
      plugin: v.software?.[0]?.name || v.slug, slug: v.slug,
      installed_version: plugins.find(p => p.slug === v.slug)?.version || '--',
      severity: v.severity || 'medium', cve: v.cve || null,
      title: v.title, recommendation: 'Update to latest version',
    }));
    res.json({ data: { vulnerabilities: vulns, plugins_checked: plugins.length,
      critical: vulns.filter(v => v.severity === 'critical').length,
      high: vulns.filter(v => v.severity === 'high').length,
      medium: vulns.filter(v => v.severity === 'medium').length },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[vulnerabilities]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/sites/:siteId/pagespeed-history ---
router.get('/sites/:siteId/pagespeed-history', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`SELECT TOP 30 * FROM arion.site_pagespeed_snapshot
        WHERE tenant_id = @tenantId AND site_id = @siteId
        ORDER BY run_date DESC`);
    res.json({ data: { snapshots: result.recordset }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[pagespeed-history]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/integrations/google/properties?siteId= ---
router.get('/integrations/google/properties', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.gbp_oauth_token_ref) return res.status(409).json({ error: { code: 'NOT_CONNECTED', message: 'Google not connected. Complete OAuth first.', status: 409 } });

    const { getAccessToken } = await import('../lib/googleBusiness.js');
    const tokenData = await getAccessToken(site.gbp_oauth_token_ref);
    if (!tokenData) return res.status(502).json({ error: { code: 'TOKEN_ERROR', message: 'Failed to refresh Google token', status: 502 } });
    const accessToken = tokenData.access_token;

    // Fetch GA4 properties
    let ga4Properties = [];
    try {
      const ga4Res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (ga4Res.ok) {
        const data = await ga4Res.json();
        for (const acct of (data.accountSummaries || [])) {
          for (const prop of (acct.propertySummaries || [])) {
            ga4Properties.push({
              propertyId: prop.property.replace('properties/', ''),
              displayName: prop.displayName,
              account: acct.displayName,
            });
          }
        }
      }
    } catch (e) { console.warn('[google/properties] GA4 list error:', e.message); }

    // Fetch GSC sites
    let gscSites = [];
    try {
      const gscRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      if (gscRes.ok) {
        const data = await gscRes.json();
        gscSites = (data.siteEntry || []).map(s => ({
          siteUrl: s.siteUrl,
          permissionLevel: s.permissionLevel,
        }));
      }
    } catch (e) { console.warn('[google/properties] GSC list error:', e.message); }

    res.json({
      data: { ga4Properties, gscSites, currentGa4PropertyId: site.ga4_property_id || null },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[google/properties]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/integrations/google/select ---
router.post('/integrations/google/select', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, ga4PropertyId, gscSiteUrl } = req.body;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const updates = [];
    const request = pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId);

    if (ga4PropertyId !== undefined) {
      request.input('ga4PropertyId', sql.NVarChar(100), ga4PropertyId || null);
      updates.push('ga4_property_id = @ga4PropertyId');
    }
    if (gscSiteUrl !== undefined) {
      request.input('gscSiteUrl', sql.NVarChar(500), gscSiteUrl || null);
      updates.push('gsc_site_url = @gscSiteUrl');
      updates.push('gsc_connected = 1');
    }
    updates.push('updated_at = GETUTCDATE()');

    await request.query(`UPDATE arion.site SET ${updates.join(', ')} WHERE tenant_id = @tenantId AND site_id = @siteId`);

    res.json({ data: { ok: true, ga4PropertyId, gscSiteUrl }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[google/select]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/analytics?siteId=&period=&compare= ---
// GA4 analytics data pipeline — returns sessions, users, channels, devices, top pages
const analyticsCache = new Map();
const ANALYTICS_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

router.get('/analytics', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const period = parseInt(req.query.period) || 30;
  const compare = req.query.compare || 'none';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    if (!site.gbp_oauth_token_ref || !site.ga4_property_id) {
      return res.json({ connected: false, error: 'not_connected' });
    }

    // Cache check
    const cacheKey = `${siteId}:${period}:${compare}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ANALYTICS_CACHE_TTL) {
      return res.json(cached.data);
    }

    // Get access token
    const { getAccessToken } = await import('../lib/googleBusiness.js');
    const tokenData = await getAccessToken(site.gbp_oauth_token_ref);
    if (!tokenData || !tokenData.access_token) {
      return res.json({ connected: true, error: 'ga4_auth_expired' });
    }
    const accessToken = tokenData.access_token;
    const propertyId = site.ga4_property_id;
    const propPath = `properties/${propertyId}`;
    const ga4Url = `https://analyticsdata.googleapis.com/v1beta/${propPath}:runReport`;

    // Date ranges
    const endDate = 'yesterday';
    const startDate = `${period}daysAgo`;
    const dateRanges = [{ startDate, endDate }];

    // Comparison date range
    if (compare !== 'none') {
      let compStart, compEnd;
      if (compare === 'previous_period') {
        compStart = `${period * 2}daysAgo`;
        compEnd = `${period + 1}daysAgo`;
      } else if (compare === 'previous_30d') {
        compStart = `${period + 30}daysAgo`;
        compEnd = `${period + 1}daysAgo`;
      } else if (compare === 'previous_90d') {
        compStart = `${period + 90}daysAgo`;
        compEnd = `${period + 1}daysAgo`;
      }
      if (compStart) dateRanges.push({ startDate: compStart, endDate: compEnd });
    }

    async function ga4Fetch(body) {
      const r = await fetch(ga4Url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`GA4 ${r.status}: ${t.slice(0, 300)}`);
      }
      return r.json();
    }

    // 1. Summary metrics
    const summaryRes = await ga4Fetch({
      dateRanges: [dateRanges[0]],
      metrics: [
        { name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' },
        { name: 'bounceRate' }, { name: 'averageSessionDuration' },
      ],
    });
    const smv = summaryRes.rows?.[0]?.metricValues || [];
    const summary = {
      totalSessions: parseInt(smv[0]?.value || '0'),
      totalUsers: parseInt(smv[1]?.value || '0'),
      totalPageviews: parseInt(smv[2]?.value || '0'),
      bounceRate: parseFloat(smv[3]?.value || '0'),
      avgSessionDuration: parseFloat(smv[4]?.value || '0'),
    };

    // 2. Sessions by day
    const dailyRes = await ga4Fetch({
      dateRanges: [dateRanges[0]],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: '366',
    });
    const sessionsByDay = (dailyRes.rows || []).map(r => ({
      date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      sessions: parseInt(r.metricValues[0].value),
    }));
    const usersByDay = (dailyRes.rows || []).map(r => ({
      date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      users: parseInt(r.metricValues[1].value),
    }));

    // 3. Channel breakdown
    const channelRes = await ga4Fetch({
      dateRanges: [dateRanges[0]],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '10',
    });
    const totalForChannels = summary.totalSessions || 1;
    const channelBreakdown = (channelRes.rows || []).map(r => ({
      channel: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value),
      pct: Math.round((parseInt(r.metricValues[0].value) / totalForChannels) * 100),
    }));

    // 4. Device split
    const deviceRes = await ga4Fetch({
      dateRanges: [dateRanges[0]],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }],
    });
    const deviceMap = {};
    let deviceTotal = 0;
    for (const r of (deviceRes.rows || [])) {
      const cat = r.dimensionValues[0].value.toLowerCase();
      const count = parseInt(r.metricValues[0].value);
      deviceMap[cat] = count;
      deviceTotal += count;
    }
    const deviceSplit = {
      mobile: deviceTotal ? Math.round((deviceMap.mobile || 0) / deviceTotal * 100) : 0,
      desktop: deviceTotal ? Math.round((deviceMap.desktop || 0) / deviceTotal * 100) : 0,
      tablet: deviceTotal ? Math.round((deviceMap.tablet || 0) / deviceTotal * 100) : 0,
    };
    // Ensure sums to 100
    const dSum = deviceSplit.mobile + deviceSplit.desktop + deviceSplit.tablet;
    if (dSum > 0 && dSum !== 100) deviceSplit.desktop += (100 - dSum);

    // 5. Top pages
    const pagesRes = await ga4Fetch({
      dateRanges: [dateRanges[0]],
      dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: '10',
    });
    const topPages = (pagesRes.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      title: r.dimensionValues[1].value,
      views: parseInt(r.metricValues[0].value),
      sessions: parseInt(r.metricValues[1].value),
      bounceRate: parseFloat(r.metricValues[2].value),
      avgDuration: parseFloat(r.metricValues[3].value),
    }));

    // 6. Traffic sources (source/medium)
    let trafficSources = [];
    try {
      const srcRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }, { name: 'keyEvents' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '15',
      });
      trafficSources = (srcRes.rows || []).map(r => ({
        source: r.dimensionValues[0].value,
        medium: r.dimensionValues[1].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        bounceRate: parseFloat(r.metricValues[2].value),
        avgDuration: parseFloat(r.metricValues[3].value),
        conversions: parseInt(r.metricValues[4].value),
      }));
    } catch (e) { console.warn('[analytics] trafficSources failed:', e.message); }

    // 7. Landing pages
    let landingPages = [];
    try {
      const lpRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'landingPagePlusQueryString' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }, { name: 'keyEvents' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      });
      landingPages = (lpRes.rows || []).map(r => ({
        page: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        bounceRate: parseFloat(r.metricValues[2].value),
        avgDuration: parseFloat(r.metricValues[3].value),
        conversions: parseInt(r.metricValues[4].value),
      }));
    } catch (e) { console.warn('[analytics] landingPages failed:', e.message); }

    // 8. Geography (countries)
    let countries = [];
    try {
      const geoRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      });
      countries = (geoRes.rows || []).map(r => ({
        country: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
      }));
    } catch (e) { console.warn('[analytics] countries failed:', e.message); }

    // 9. Cities
    let cities = [];
    try {
      const cityRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'city' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '10',
      });
      cities = (cityRes.rows || []).map(r => ({
        city: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
      }));
    } catch (e) { console.warn('[analytics] cities failed:', e.message); }

    // 10. Browser breakdown
    let browsers = [];
    try {
      const brRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'browser' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: '8',
      });
      browsers = (brRes.rows || []).map(r => ({
        browser: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
      }));
    } catch (e) { console.warn('[analytics] browsers failed:', e.message); }

    // 11. New vs returning users
    let newVsReturning = [];
    try {
      const nvrRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'newVsReturning' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagementRate' }],
      });
      newVsReturning = (nvrRes.rows || []).map(r => ({
        type: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
        engagementRate: parseFloat(r.metricValues[2].value),
      }));
    } catch (e) { console.warn('[analytics] newVsReturning failed:', e.message); }

    // 12. Engagement metrics
    let engagement = {};
    try {
      const engRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        metrics: [
          { name: 'engagedSessions' }, { name: 'engagementRate' },
          { name: 'eventsPerSession' }, { name: 'screenPageViewsPerSession' },
          { name: 'sessionsPerUser' }, { name: 'newUsers' },
          { name: 'eventCount' }, { name: 'keyEvents' },
          { name: 'scrolledUsers' },
        ],
      });
      const emv = engRes.rows?.[0]?.metricValues || [];
      engagement = {
        engagedSessions: parseInt(emv[0]?.value || '0'),
        engagementRate: parseFloat(emv[1]?.value || '0'),
        eventsPerSession: parseFloat(emv[2]?.value || '0'),
        pageviewsPerSession: parseFloat(emv[3]?.value || '0'),
        sessionsPerUser: parseFloat(emv[4]?.value || '0'),
        newUsers: parseInt(emv[5]?.value || '0'),
        totalEvents: parseInt(emv[6]?.value || '0'),
        keyEvents: parseInt(emv[7]?.value || '0'),
        scrolledUsers: parseInt(emv[8]?.value || '0'),
      };
    } catch (e) { console.warn('[analytics] engagement failed:', e.message); }

    // 13. Pageviews by day (for content trend)
    let pageviewsByDay = [];
    try {
      const pvRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: '366',
      });
      pageviewsByDay = (pvRes.rows || []).map(r => ({
        date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
        pageviews: parseInt(r.metricValues[0].value),
      }));
    } catch (e) { console.warn('[analytics] pageviewsByDay failed:', e.message); }

    // 14. Hours of day (best time to post)
    let hourlyBreakdown = [];
    try {
      const hourRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'hour' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'hour' } }],
      });
      hourlyBreakdown = (hourRes.rows || []).map(r => ({
        hour: parseInt(r.dimensionValues[0].value),
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
      }));
    } catch (e) { console.warn('[analytics] hourlyBreakdown failed:', e.message); }

    // 15. Day of week
    let dayOfWeekBreakdown = [];
    try {
      const dowRes = await ga4Fetch({
        dateRanges: [dateRanges[0]],
        dimensions: [{ name: 'dayOfWeekName' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      });
      dayOfWeekBreakdown = (dowRes.rows || []).map(r => ({
        day: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        users: parseInt(r.metricValues[1].value),
      }));
    } catch (e) { console.warn('[analytics] dayOfWeekBreakdown failed:', e.message); }

    // 6. Comparison (if requested) — full breakdowns for comparison period
    let comparison = null;
    if (dateRanges.length > 1) {
      try {
        // Comparison summary
        const compRes = await ga4Fetch({
          dateRanges: [dateRanges[1]],
          metrics: [
            { name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' },
            { name: 'bounceRate' }, { name: 'averageSessionDuration' },
            { name: 'engagedSessions' }, { name: 'engagementRate' },
            { name: 'eventsPerSession' }, { name: 'screenPageViewsPerSession' },
          ],
        });
        const cmv = compRes.rows?.[0]?.metricValues || [];
        const compSummary = {
          totalSessions: parseInt(cmv[0]?.value || '0'),
          totalUsers: parseInt(cmv[1]?.value || '0'),
          totalPageviews: parseInt(cmv[2]?.value || '0'),
          bounceRate: parseFloat(cmv[3]?.value || '0'),
          avgSessionDuration: parseFloat(cmv[4]?.value || '0'),
          engagedSessions: parseInt(cmv[5]?.value || '0'),
          engagementRate: parseFloat(cmv[6]?.value || '0'),
          eventsPerSession: parseFloat(cmv[7]?.value || '0'),
          pageviewsPerSession: parseFloat(cmv[8]?.value || '0'),
        };

        // Comparison daily sessions (for chart overlay)
        let compSessionsByDay = [];
        try {
          const compDaily = await ga4Fetch({
            dateRanges: [dateRanges[1]],
            dimensions: [{ name: 'date' }],
            metrics: [{ name: 'sessions' }],
            orderBys: [{ dimension: { dimensionName: 'date' } }],
            limit: '366',
          });
          compSessionsByDay = (compDaily.rows || []).map(r => ({
            date: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
            sessions: parseInt(r.metricValues[0].value),
          }));
        } catch (e) { /* ignore */ }

        // Comparison channels
        let compChannels = [];
        try {
          const compCh = await ga4Fetch({
            dateRanges: [dateRanges[1]],
            dimensions: [{ name: 'sessionDefaultChannelGroup' }],
            metrics: [{ name: 'sessions' }],
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
            limit: '10',
          });
          compChannels = (compCh.rows || []).map(r => ({
            channel: r.dimensionValues[0].value,
            sessions: parseInt(r.metricValues[0].value),
          }));
        } catch (e) { /* ignore */ }

        // Comparison devices
        let compDevices = {};
        try {
          const compDev = await ga4Fetch({
            dateRanges: [dateRanges[1]],
            dimensions: [{ name: 'deviceCategory' }],
            metrics: [{ name: 'sessions' }],
          });
          let devTotal = 0;
          const devMap = {};
          for (const r of (compDev.rows || [])) {
            const c = parseInt(r.metricValues[0].value);
            devMap[r.dimensionValues[0].value.toLowerCase()] = c;
            devTotal += c;
          }
          compDevices = {
            mobile: devTotal ? Math.round((devMap.mobile || 0) / devTotal * 100) : 0,
            desktop: devTotal ? Math.round((devMap.desktop || 0) / devTotal * 100) : 0,
            tablet: devTotal ? Math.round((devMap.tablet || 0) / devTotal * 100) : 0,
          };
        } catch (e) { /* ignore */ }

        // Comparison new vs returning
        let compNewVsReturning = [];
        try {
          const compNvr = await ga4Fetch({
            dateRanges: [dateRanges[1]],
            dimensions: [{ name: 'newVsReturning' }],
            metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
          });
          compNewVsReturning = (compNvr.rows || []).map(r => ({
            type: r.dimensionValues[0].value,
            sessions: parseInt(r.metricValues[0].value),
            users: parseInt(r.metricValues[1].value),
          }));
        } catch (e) { /* ignore */ }

        comparison = {
          summary: compSummary,
          sessionsByDay: compSessionsByDay,
          channelBreakdown: compChannels,
          deviceSplit: compDevices,
          newVsReturning: compNewVsReturning,
          deltas: {
            sessions: summary.totalSessions - compSummary.totalSessions,
            sessionsPct: compSummary.totalSessions ? Math.round(((summary.totalSessions - compSummary.totalSessions) / compSummary.totalSessions) * 100) : null,
            users: summary.totalUsers - compSummary.totalUsers,
            usersPct: compSummary.totalUsers ? Math.round(((summary.totalUsers - compSummary.totalUsers) / compSummary.totalUsers) * 100) : null,
            pageviews: summary.totalPageviews - compSummary.totalPageviews,
          },
        };
      } catch (e) { console.warn('[analytics] comparison query failed:', e.message); }
    }

    // Calculate date range strings
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() - 1);
    const start = new Date(now);
    start.setDate(start.getDate() - period);

    const result = {
      connected: true,
      period,
      dateRange: { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] },
      summary,
      engagement,
      sessionsByDay,
      usersByDay,
      pageviewsByDay,
      channelBreakdown,
      deviceSplit,
      topPages,
      landingPages,
      trafficSources,
      countries,
      cities,
      browsers,
      newVsReturning,
      hourlyBreakdown,
      dayOfWeekBreakdown,
      comparison,
    };

    // Cache
    analyticsCache.set(cacheKey, { data: result, ts: Date.now() });

    res.json(result);
  } catch (err) {
    console.error('[arion/analytics]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/analytics/insights?siteId= ---
router.get('/analytics/insights', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`SELECT report_type, period_start, period_end, generated_at, argus_insights, tier_generated
        FROM arion.insight_reports WHERE tenant_id = @tenantId AND site_id = @siteId
        ORDER BY generated_at DESC`);
    const reports = result.recordset.map(r => ({
      reportType: r.report_type,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      generatedAt: r.generated_at,
      tierGenerated: r.tier_generated,
      argusInsights: r.argus_insights ? JSON.parse(r.argus_insights) : null,
    }));
    res.json({ data: reports, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[analytics/insights]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
