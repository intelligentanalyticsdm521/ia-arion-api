import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { generateSiteToken, hashSiteToken } from '../lib/siteToken.js';
import { getSearchConsoleData, getSearchConsolePages, getSearchConsoleDevices, getSearchConsoleCountries } from '../lib/googleServices.js';
import { getAccessToken } from '../lib/googleBusiness.js';
import { getTrafficData as bingGetTrafficData, getPageTrafficData as bingGetPageTrafficData, getSitemaps as bingGetSitemaps, submitUrl as bingSubmitUrl, getUrlSubmissionQuota as bingGetUrlSubmissionQuota, getCrawlStats as bingGetCrawlStats } from '../lib/bingWebmaster.js';
import { fetchWordPressPages, detectSitemapUrl, submitToGoogle, submitToBing } from '../lib/sitemapGenerator.js';
import { getDomainInfo, getDnsRecords, getSslStatus, getWpSiteInfo, getWpPages, getWpPosts } from '../lib/hostinger.js';
import formsRouter from './arion/forms.js';
import bookingsRouter from './arion/bookings.js';

const router = Router();

// Sub-routers for site-scoped data (blueprint routes)
router.use('/sites/:siteId/forms', formsRouter);
router.use('/sites/:siteId/bookings', bookingsRouter);

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

    const [domainInfo, dnsRecords, sslInfo, wpInfo, wpPages, wpPosts] = await Promise.all([
      site.domain ? safeCall(getDomainInfo(site.domain)) : null,
      site.domain ? safeCall(getDnsRecords(site.domain)) : null,
      site.domain ? safeCall(getSslStatus(site.domain)) : null,
      site.domain ? safeCall(getWpSiteInfo(site.domain)) : null,
      site.domain ? safeCall(getWpPages(site.domain)) : null,
      site.domain ? safeCall(getWpPosts(site.domain)) : null,
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
        sslStatus: sslInfo?.ssl_active != null ? (sslInfo.ssl_active ? 'valid' : 'expired') : (site.ssl_expiry ? (new Date(site.ssl_expiry) > new Date() ? 'valid' : 'expired') : null),
        sslExpiry: sslInfo?.expires_at || site.ssl_expiry || null,
        sslIssuer: sslInfo?.issuer || null,
        hostingPlan: site.hosting_plan || null,
        siteStatus: site.status,
        wordpressVersion: wpInfo?.version || null,
        phpVersion: null, // needs SSH
        siteName: wpInfo?.name || null,
        siteDescription: wpInfo?.description || null,
        pageCount: wpPages?.length ?? null,
        postCount: wpPosts?.length ?? null,
        performanceScore: null, // needs PageSpeed API
        lastHealthCheckAt: new Date().toISOString(),
      },
      domain: domainInfo ? {
        name: domainInfo.domain || site.domain,
        status: domainInfo.status || null,
        expiresAt: domainInfo.expires_at || domainInfo.expiry_date || null,
        autoRenew: domainInfo.auto_renewal ?? null,
        whoisPrivacy: domainInfo.whois_privacy ?? null,
        registrar: domainInfo.registrar || 'Hostinger',
        nameservers: domainInfo.nameservers || [],
      } : null,
      dns: dnsRecords || [],
      ssl: sslInfo || null,
      wordpress: wpInfo ? {
        version: wpInfo.version || null,
        name: wpInfo.name || null,
        description: wpInfo.description || null,
        url: wpInfo.url || null,
      } : null,
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
      plugins: [], // still needs SSH/WP-CLI or auth'd REST API
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
        if (summaryRes) { const s = summaryRes.recordset[0]; summary = { clicks: s?.clicks ?? null, impressions: s?.impressions ?? null, ctr: s?.ctr ?? null, avgPosition: s?.avgPosition ?? null }; }
        if (queriesRes) breakdowns.queries = queriesRes.recordset.map(r => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, avgPosition: r.avgPosition }));
        if (pagesRes) breakdowns.pages = pagesRes.recordset.map(r => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, avgPosition: r.avgPosition }));
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

// --- GET /arion/search/performance?siteId=&provider=google|bing&days=28 ---
router.get('/search/performance', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const provider = (req.query.provider || 'google').toLowerCase();
  const days = parseInt(req.query.days, 10) || 28;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const safeCall = (promise) => promise.catch(e => { console.warn('[arion/search/performance] API call failed:', e.message); return null; });
    let summary = { clicks: null, impressions: null, ctr: null, avgPosition: null };
    let breakdowns = { queries: [], pages: [] };

    if (provider === 'google') {
      const refreshToken = site.gbp_oauth_token_ref;
      if (!refreshToken) return res.json({ provider, summary, breakdowns, error: 'Google not connected' });
      const siteUrl = 'https://' + site.domain;
      const [queryData, pageData] = await Promise.all([
        safeCall(getSearchConsoleData(refreshToken, siteUrl, days)),
        safeCall(getSearchConsolePages(refreshToken, siteUrl, days)),
      ]);
      if (queryData) {
        summary = { clicks: queryData.summary.clicks, impressions: queryData.summary.impressions, ctr: queryData.summary.ctr, avgPosition: queryData.summary.position };
        breakdowns.queries = queryData.queries || [];
      }
      if (pageData) {
        breakdowns.pages = pageData || [];
      }
    } else if (provider === 'bing') {
      const bingKey = process.env.BING_WMT_API_KEY;
      if (!bingKey) return res.json({ provider, summary, breakdowns, error: 'Bing not configured' });
      const siteUrl = 'https://' + site.domain;
      const [trafficData, pageData] = await Promise.all([
        safeCall(bingGetTrafficData(bingKey, siteUrl, days)),
        safeCall(bingGetPageTrafficData(bingKey, siteUrl)),
      ]);
      if (trafficData && Array.isArray(trafficData)) {
        const totals = trafficData.reduce((acc, r) => { acc.clicks += r.Clicks || 0; acc.impressions += r.Impressions || 0; return acc; }, { clicks: 0, impressions: 0 });
        summary = { clicks: totals.clicks, impressions: totals.impressions, ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0, avgPosition: null };
        breakdowns.queries = trafficData.map(r => ({ query: r.Query || '', clicks: r.Clicks || 0, impressions: r.Impressions || 0, ctr: r.Impressions > 0 ? (r.Clicks || 0) / r.Impressions : 0, position: r.AvgPosition ?? null }));
      }
      if (pageData && Array.isArray(pageData)) {
        breakdowns.pages = pageData.map(r => ({ page: r.Url || r.Page || '', clicks: r.Clicks || 0, impressions: r.Impressions || 0, ctr: r.Impressions > 0 ? (r.Clicks || 0) / r.Impressions : 0, position: r.AvgPosition ?? null }));
      }
    } else {
      return res.status(400).json({ error: { code: 'INVALID_PROVIDER', message: 'provider must be google or bing', status: 400 } });
    }

    res.json({ provider, summary, breakdowns });
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
    if (!refreshToken) return res.json({ inspection: null, error: 'Google not connected' });

    const tokenData = await getAccessToken(refreshToken).catch(() => null);
    if (!tokenData) return res.json({ inspection: null, error: 'Failed to get access token' });

    const siteUrl = 'https://' + site.domain;
    let inspection = null;
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
        console.warn('[arion/search/url-inspection] GSC API error:', apiRes.status, text.slice(0, 200));
      }
    } catch (e) {
      console.warn('[arion/search/url-inspection] API call failed:', e.message);
    }

    res.json({ inspection });
  } catch (err) {
    console.error('[arion/search/url-inspection]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/search/submit-url?siteId= ---
router.post('/search/submit-url', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const { url } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!url) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'url is required in body', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const siteUrl = 'https://' + site.domain;
    let googleResult = null;
    let bingResult = null;

    // Google Indexing API (placeholder — requires separate service account setup)
    googleResult = { submitted: false, message: 'Google Indexing API not yet configured' };

    // Bing URL submission
    const bingKey = process.env.BING_WMT_API_KEY;
    if (bingKey) {
      try {
        bingResult = await bingSubmitUrl(bingKey, siteUrl, url);
      } catch (e) {
        console.warn('[arion/search/submit-url] Bing submit failed:', e.message);
        bingResult = null;
      }
    }

    res.json({ url, google: googleResult, bing: bingResult });
  } catch (err) {
    console.error('[arion/search/submit-url]', err);
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
      const siteUrl = encodeURIComponent('https://' + site.domain);
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
      const bingKey = process.env.BING_WMT_API_KEY;
      if (!bingKey) return res.json({ provider, sitemaps: [], error: 'Bing not configured' });
      const siteUrl = 'https://' + site.domain;
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
// Business Routes
// ---------------------------------------------------------------------------

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

// --- GET /arion/business/posts?siteId= ---
router.get('/business/posts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    res.json({ posts: [] });
  } catch (err) {
    console.error('[arion/business/posts]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/business/posts?siteId= ---
router.post('/business/posts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    res.json({ ok: true, post: null });
  } catch (err) {
    console.error('[arion/business/posts:create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
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

    // 1. Detect existing sitemap URL
    const sitemapUrl = await detectSitemapUrl(domain);

    // 2. Crawl WP REST API for page/post count
    let wpUrls = [];
    try {
      wpUrls = await fetchWordPressPages(domain);
    } catch (err) {
      console.warn('[arion/search/generate-sitemap] WP REST API crawl failed:', err.message);
    }

    // 3. Submit to Google if connected
    const submittedTo = [];
    let googleResult = null;
    let bingResult = null;

    if (sitemapUrl) {
      const siteUrl = 'https://' + domain;
      const refreshToken = site.gbp_oauth_token_ref;

      // Google
      if (refreshToken) {
        const tokenData = await getAccessToken(refreshToken).catch(() => null);
        if (tokenData?.access_token) {
          googleResult = await submitToGoogle(tokenData.access_token, siteUrl, sitemapUrl);
          if (googleResult.submitted) submittedTo.push('google');
        }
      }

      // Bing
      const bingKey = process.env.BING_WMT_API_KEY;
      if (bingKey) {
        bingResult = await submitToBing(bingKey, siteUrl, sitemapUrl);
        if (bingResult.submitted) submittedTo.push('bing');
      }
    }

    res.json({
      urls: wpUrls.length,
      sitemapUrl: sitemapUrl || null,
      sitemapDetected: !!sitemapUrl,
      submittedTo,
      google: googleResult,
      bing: bingResult,
    });
  } catch (err) {
    console.error('[arion/search/generate-sitemap]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
