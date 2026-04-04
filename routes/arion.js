import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { firePlatformEvent } from '../lib/platformEvents.js';
import { generateSiteToken, hashSiteToken } from '../lib/siteToken.js';
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
    arionTier: row.arion_tier
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
    let formsCount = 0, bookingsCount = 0, gscSummary = null, gbpProfile = null, seoSummary = null;
    if (site) {
      const [formsRes, bookingsRes, gscRes, gbpRes, seoRes] = await Promise.all([
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT COUNT(*) AS cnt FROM arion.site_form_submission WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= DATEADD(day, -30, GETUTCDATE())'),
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT COUNT(*) AS cnt FROM arion.site_booking_request WHERE tenant_id = @tenantId AND site_id = @siteId AND submitted_at >= DATEADD(day, -30, GETUTCDATE())'),
        site.gsc_connected ? pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -30, GETUTCDATE())') : Promise.resolve(null),
        site.gbp_connected ? pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId') : Promise.resolve(null),
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .query('SELECT TOP 1 * FROM arion.se_ranking_summary WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY fetched_at DESC')
      ]);
      formsCount = formsRes.recordset[0].cnt;
      bookingsCount = bookingsRes.recordset[0].cnt;
      gscSummary = gscRes?.recordset?.[0] || null;
      gbpProfile = gbpRes?.recordset?.[0] || null;
      seoSummary = seoRes.recordset[0] || null;
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
      hosting: { siteStatus: site?.status || null, sslStatus: site?.ssl_expiry ? (new Date(site.ssl_expiry) > new Date() ? 'valid' : 'expired') : null, pluginUpdatesAvailable: null, wordpressVersion: null, phpVersion: null, performanceScore: null, lastHealthCheckAt: null },
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
    res.json({
      site: toSiteSummary(site),
      health: {
        domain: site.domain || null,
        sslExpiry: site.ssl_expiry || null,
        hostingPlan: site.hosting_plan || null,
        wordpressVersion: null,
        phpVersion: null,
        pluginUpdatesAvailable: null,
        themeUpdatesAvailable: null,
        sslStatus: site.ssl_expiry ? (new Date(site.ssl_expiry) > new Date() ? 'valid' : 'expired') : null,
        siteStatus: site.status,
        lastHealthCheckAt: null,
        formDeliveryStatus: null,
        performanceScore: null
      },
      plugins: [],
      requests: []
    });
  } catch (err) {
    console.error('[arion/hosting]', err);
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
      const [summaryRes, queriesRes, pagesRes] = await Promise.all([
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE())'),
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT TOP 20 query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE()) AND query IS NOT NULL GROUP BY query ORDER BY SUM(impressions) DESC'),
        pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT TOP 20 page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, AVG(ctr) AS ctr, AVG(position) AS avgPosition FROM arion.gsc_data WHERE tenant_id = @tenantId AND site_id = @siteId AND report_date >= DATEADD(day, -28, GETUTCDATE()) AND page IS NOT NULL GROUP BY page ORDER BY SUM(impressions) DESC')
      ]);
      const s = summaryRes.recordset[0];
      summary = { clicks: s.clicks ?? null, impressions: s.impressions ?? null, ctr: s.ctr ?? null, avgPosition: s.avgPosition ?? null };
      breakdowns.queries = queriesRes.recordset.map(r => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, avgPosition: r.avgPosition }));
      breakdowns.pages = pagesRes.recordset.map(r => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, avgPosition: r.avgPosition }));
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
    let connected = site.se_ranking_project_id ? true : false;
    let integration = null;
    let sePackage = { code: site.seo_addon_tier || null, label: null, keywordLimit: null, competitorLimit: null, modelLimit: null, groupLimit: null, aiEnabled: false, dataApiEnabled: false };
    let snapshot = { visibilityScore: null, auditScore: null, trackedKeywords: null, trackedCompetitors: null, trackedModels: null, criticalIssues: null, warningIssues: null };
    let breakdowns = {};

    if (connected && site.seo_addon_tier) {
      const seoRes = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query('SELECT TOP 1 * FROM arion.se_ranking_summary WHERE tenant_id = @tenantId AND site_id = @siteId ORDER BY fetched_at DESC');
      const row = seoRes.recordset[0];
      if (row) {
        snapshot = {
          visibilityScore: row.visibility_score ?? null,
          auditScore: row.audit_score ?? null,
          trackedKeywords: row.tracked_keywords ?? null,
          trackedCompetitors: row.tracked_competitors ?? null,
          trackedModels: row.tracked_models ?? null,
          criticalIssues: row.critical_issues ?? null,
          warningIssues: row.warning_issues ?? null
        };
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
      const gbpRes = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query('SELECT * FROM arion.gbp_profile WHERE tenant_id = @tenantId AND site_id = @siteId');
      const row = gbpRes.recordset[0];
      if (row) {
        profile = {
          connected: true,
          editable: true,
          displayName: row.business_name || null,
          primaryCategory: row.categories || null,
          websiteUrl: row.website || null,
          mapsUrl: null,
          phone: row.phone || null,
          address: row.address || null,
          hours: row.hours || null,
          resourceUrl: null,
          integration: null
        };
      }
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

export default router;
