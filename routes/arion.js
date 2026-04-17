import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { generateSiteToken, hashSiteToken } from '../lib/siteToken.js';
import { getSearchConsoleData, getSearchConsolePages, getSearchConsoleDevices, getSearchConsoleCountries, getAnalyticsData } from '../lib/googleServices.js';
import { getAccessToken } from '../lib/googleBusiness.js';
import { getTrafficData as bingGetTrafficData, getPageTrafficData as bingGetPageTrafficData, getSitemaps as bingGetSitemaps, submitUrl as bingSubmitUrl, getUrlSubmissionQuota as bingGetUrlSubmissionQuota, getCrawlStats as bingGetCrawlStats } from '../lib/bingWebmaster.js';
import { fetchWordPressPages, detectSitemapUrl, submitToGoogle, submitToBing } from '../lib/sitemapGenerator.js';
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

    // 6. Comparison (if requested)
    let comparison = null;
    if (dateRanges.length > 1) {
      try {
        const compRes = await ga4Fetch({
          dateRanges: [dateRanges[1]],
          metrics: [
            { name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' },
            { name: 'bounceRate' }, { name: 'averageSessionDuration' },
          ],
        });
        const cmv = compRes.rows?.[0]?.metricValues || [];
        const compSummary = {
          totalSessions: parseInt(cmv[0]?.value || '0'),
          totalUsers: parseInt(cmv[1]?.value || '0'),
          totalPageviews: parseInt(cmv[2]?.value || '0'),
          bounceRate: parseFloat(cmv[3]?.value || '0'),
          avgSessionDuration: parseFloat(cmv[4]?.value || '0'),
        };
        comparison = {
          summary: compSummary,
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
