import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { getPlatformPool } from '../db/platformPool.js';
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
import { plugin as pluginApi, pluginGet, pluginPost, pluginFetchAll } from '../lib/pluginClient.js';
import { meetsMinTier } from '../lib/tierCheck.js';
import { getKeywordPositions, getProjectCompetitors, getAuditSummary, getProjectKeywords, getSiteOverview, getPositionsHistory, startSiteAudit, addCompetitor as seRankingAddCompetitor, rawRequest as seRankingRaw } from '../lib/seranking.js';
import { getKeywordData as seRankingKeywordData } from '../lib/serankingData.js';
import { parsePositions, computeAggregateStats, resolveRange, buildEngineMetaMap } from '../lib/serankingParse.js';
import formsRouter from './arion/forms.js';
import bookingsRouter from './arion/bookings.js';
import gbpRouter from './arion/gbp.js';
import integrationsRouter from './arion/integrations.js';
import domainsRouter from './arion/domains.js';
import pluginRouter from './arion/plugin.js';

const router = Router();

// Sub-routers for site-scoped data (blueprint routes)
router.use('/sites/:siteId/forms', formsRouter);
router.use('/sites/:siteId/bookings', bookingsRouter);
router.use('/sites/:siteId/gbp', gbpRouter);
router.use('/sites/:siteId', integrationsRouter);
router.use('/sites/:siteId/domain', domainsRouter);

// Cross-product plugin proxy — used by LUMEN-API for newsletter publishing.
router.use('/plugin', pluginRouter);

// GET /arion/onboarding/checklist — in-app onboarding parity with
// SPARK/OLIVER. Real completion from arion.site columns. The SE Ranking
// step is the IA SEO add-on (seoAddon → UI shows "Add Intelligent
// Analytics SEO package to access this" rather than a generic upgrade).
router.get('/onboarding/checklist', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 site_id, domain, status, ga4_property_id,
                     gsc_connected, gbp_connected, bing_connected,
                     se_ranking_project_id
              FROM arion.site WHERE tenant_id=@tenantId
              ORDER BY created_at`);
    const s = r.recordset[0] || null;

    const CATALOG = [
      { key: 'arion_site',      group: 'ARION', label: 'Create your website',                 required: true,  done: !!s },
      { key: 'arion_ga4',       group: 'ARION', label: 'Connect Google Analytics 4',          required: true,  done: !!s?.ga4_property_id },
      { key: 'arion_gsc',       group: 'ARION', label: 'Connect Google Search Console',       required: false, done: !!s && s.gsc_connected === true },
      { key: 'arion_gbp',       group: 'ARION', label: 'Connect Google Business Profile',     required: false, done: !!s && s.gbp_connected === true },
      { key: 'arion_bing',      group: 'ARION', label: 'Connect Bing Webmaster Tools',        required: false, done: !!s && s.bing_connected === true },
      { key: 'arion_seranking', group: 'SEO',   label: 'Set up SE Ranking (SEO tracking)',    required: false, done: !!s?.se_ranking_project_id, seoAddon: true },
    ];
    const steps = CATALOG.map((x) => ({
      product: 'arion',
      ...x,
      // SEO step is "locked" behind the IA SEO package until provisioned.
      locked: x.seoAddon === true && !x.done,
      requiredAddon: x.seoAddon === true && !x.done ? 'Intelligent Analytics SEO package' : null,
    }));
    const total = steps.length;
    const done = steps.filter((x) => x.done).length;
    const requiredTotal = steps.filter((x) => x.required).length;
    const requiredDone = steps.filter((x) => x.required && x.done).length;
    return res.json({
      data: {
        siteId: s?.site_id || null,
        domain: s?.domain || null,
        steps,
        progress: {
          done, total,
          required_done: requiredDone, required_total: requiredTotal,
          percent: total ? Math.round((done / total) * 100) : 0,
          required_percent: requiredTotal ? Math.round((requiredDone / requiredTotal) * 100) : 0,
        },
      },
    });
  } catch (err) {
    console.error('[arion onboarding.checklist]', err);
    return res.status(500).json({ error: err.message });
  }
});

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
    // 2026-06-20 — real WP activity timestamp. The IA plugin writes
    // arion.site_content_change rows when pages/posts/products/custom
    // post types change. Falls back to plugin_last_status_at (plugin
    // heartbeat) and finally site row mtime so we never show '—' for an
    // active site. Frontend renders this as "Last activity".
    lastContentChangeAt: row.last_content_change_at || row.plugin_last_status_at || row.updated_at,
    arionTier: row.arion_tier,
    seoAddonTier: row.seo_addon_tier || null
  };
}

// Helper: get site by siteId + tenantId
export async function getSiteForTenant(pool, tenantId, siteId) {
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
    // 2026-06-20 — also compute lastContentChangeAt per site. Brandon
    // pointed out the header was showing arion.site.updated_at (DB row
    // mtime — only flips on admin edits) as "Last updated" while he
    // publishes pages/posts multiple times a week. The IA plugin writes
    // into arion.site_content_change on every WP content event, so
    // MAX(changed_at) per site is a real freshness signal.
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT s.*,
               (SELECT MAX(scc.changed_at)
                  FROM arion.site_content_change scc
                 WHERE scc.site_id = s.site_id) AS last_content_change_at
          FROM arion.site s
         WHERE s.tenant_id = @tenantId
         ORDER BY s.created_at DESC
      `);
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
    // wp_admin_url may already end in "/wp-admin" or "/wp-admin/" — normalize
    // to exactly one trailing "/wp-admin/" without doubling it up.
    let adminUrl = site.wp_admin_url.replace(/\/+$/, ''); // strip trailing slashes
    if (!/\/wp-admin$/i.test(adminUrl)) {
      adminUrl += '/wp-admin';
    }
    adminUrl += '/';
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

    // Enrich breakdowns with real SE Ranking data (Phase 3.5 parser).
    if (site.se_ranking_project_id) {
      const projectId = site.se_ranking_project_id;
      const range = resolveRange('30d');
      const positionsRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.current.start}&date_to=${range.current.end}`);
      const engineBlocks = Array.isArray(positionsRaw.data) ? positionsRaw.data : [];
      const engineIds = Array.from(new Set(engineBlocks.map((b) => String(b.site_engine_id))));
      const engineMetaById = await loadEngineMetaForProject(projectId, engineIds).catch(() => ({}));

      const keywordsNormalized = parsePositions(engineBlocks, {
        rangeStart: range.current.start,
        rangeEnd: range.current.end,
        engineMetaById,
      });
      const stats = computeAggregateStats(keywordsNormalized);

      // Legacy-compat shape for SeoOverview page (still using old field names
      // until Phase 3.5 frontend rebuild lands).
      const aggregatedRankings = keywordsNormalized.map((k) => ({
        keywordId: k.keywordId,
        keyword: k.keyword,
        position: k.currentPosition,
        change: k.positionChange,
        volume: k.searchVolume,
        difficulty: k.difficulty,
        serp_features: [],
        url: null,
        engines: k.perEngine.map((e) => e.engineId),
      }));

      snapshot.avgPosition = stats.avgPosition;
      snapshot.searchVisibility = stats.visibilityScore;
      snapshot.top10Count = stats.top10Count;
      snapshot.trafficForecast = stats.trafficForecast;

      const firstEngineId = engineIds[0];
      let competitors = [];
      if (firstEngineId) {
        const compRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/competitors?se_id=${encodeURIComponent(firstEngineId)}`);
        if (compRaw.ok && Array.isArray(compRaw.data)) competitors = compRaw.data;
      }

      const opportunities = aggregatedRankings
        .filter((k) => typeof k.position === 'number' && k.position >= 11 && k.position <= 20)
        .sort((a, b) => (b.volume || 0) - (a.volume || 0))
        .map((k) => ({
          keyword: k.keyword,
          position: k.position,
          volume: k.volume,
          difficulty: k.difficulty,
          estimatedMonthlyClicks: Math.round((k.volume || 0) * 0.28),
        }));

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

// --- GET /arion/sites/:siteId/gbp/locations ---
// SECURITY: surfaces ALL accounts + locations the OAuth'd Google user
// can access. Portal renders this as a picker.
//
// SMART AUTO-PICK (v2.0.13): if there's exactly ONE location on the account,
// or if exactly one location has a domain match with the site, save it
// automatically and return auto_selected=true. Reduces friction for the
// 90%+ of small-biz clients with a single GBP listing.
router.get('/sites/:siteId/gbp/locations', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.gbp_connected || !site.gbp_oauth_token_ref) {
      return res.status(400).json({ error: { code: 'NOT_CONNECTED', message: 'Connect Google first', status: 400 } });
    }
    const tokenData = await getAccessToken(site.gbp_oauth_token_ref).catch(() => null);
    if (!tokenData) return res.status(401).json({ error: { code: 'AUTH_EXPIRED', message: 'Google authorization expired — reconnect', status: 401 } });

    const { listAllGbpLocations } = await import('../lib/gbpApi.js');
    const locations = await listAllGbpLocations(tokenData.access_token, site.domain);

    let autoSelected = null;
    let currentlySelected = site.gbp_location_name || null;

    // Auto-pick rules — only run when nothing is selected yet
    if (!currentlySelected && locations.length > 0) {
      const exactMatches = locations.filter((l) => l.match_score >= 1.0);
      if (locations.length === 1) {
        autoSelected = locations[0]; // only one option, no ambiguity
      } else if (exactMatches.length === 1) {
        autoSelected = exactMatches[0]; // exactly one domain-matched listing
      }
      if (autoSelected) {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('locationName', sql.NVarChar(200), autoSelected.location_name)
          .query('UPDATE arion.site SET gbp_location_name = @locationName WHERE tenant_id = @tenantId AND site_id = @siteId');
        currentlySelected = autoSelected.location_name;
      }
    }

    res.json({
      data: {
        locations,
        currently_selected: currentlySelected,
        site_domain: site.domain,
        suggestion: locations.find((l) => l.match_score >= 1.0)?.location_name || null,
        auto_selected: autoSelected ? { location_name: autoSelected.location_name, title: autoSelected.title, reason: locations.length === 1 ? 'only_listing' : 'unique_domain_match' } : null,
      },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[gbp/locations]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/sites/:siteId/gbp/select-location ---
// User explicitly selects which GBP location belongs to this site.
router.post('/sites/:siteId/gbp/select-location', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { location_name } = req.body;
  if (!location_name || !/^accounts\/\d+\/locations\/\d+$/.test(location_name)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'location_name must match accounts/{a}/locations/{l}', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.gbp_oauth_token_ref) return res.status(400).json({ error: { code: 'NOT_CONNECTED', message: 'Connect Google first', status: 400 } });

    // Verify the location is actually one this user can access — prevents
    // an attacker from setting an arbitrary location_name they don't own
    const tokenData = await getAccessToken(site.gbp_oauth_token_ref).catch(() => null);
    if (!tokenData) return res.status(401).json({ error: { code: 'AUTH_EXPIRED', message: 'Google authorization expired', status: 401 } });
    const { listAllGbpLocations } = await import('../lib/gbpApi.js');
    const locations = await listAllGbpLocations(tokenData.access_token, site.domain);
    const found = locations.find((l) => l.location_name === location_name);
    if (!found) {
      return res.status(403).json({ error: { code: 'NOT_AUTHORIZED', message: 'Selected location is not in your authorized GBP list', status: 403 } });
    }

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('locationName', sql.NVarChar(200), location_name)
      .input('placeId', sql.NVarChar(80), found.place_id || null)
      .query('UPDATE arion.site SET gbp_location_name = @locationName, gbp_place_id = @placeId WHERE tenant_id = @tenantId AND site_id = @siteId');

    // Cross-product: push the Google place id + review URL to the SHARED
    // tenant profile (core.tenants) so OLIVER review-request automation,
    // invoices, and the customer portal use it automatically — set once in
    // ARION, used everywhere. Guarded: a pre-migration-004 DB just skips it.
    if (found.place_id || found.review_uri) {
      try {
        const platformPool = await getPlatformPool();
        await platformPool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('placeId', sql.NVarChar(80), found.place_id || null)
          .input('reviewUrl', sql.NVarChar(500), found.review_uri || null)
          .query('UPDATE core.tenants SET google_place_id = @placeId, google_review_url = @reviewUrl WHERE tenant_id = @tenantId');
      } catch (shareErr) {
        console.warn('[gbp/select-location] shared-profile write skipped (migration 004 not applied?):', shareErr.message);
      }
    }

    res.json({
      data: { selected: location_name, title: found.title, address: found.address, website_uri: found.website_uri, place_id: found.place_id || null },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[gbp/select-location]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/sites/:siteId/gbp/disconnect ---
// Clears the SELECTED LOCATION but keeps the shared OAuth token because
// Google Analytics + Search Console + Business Profile all use the same
// gbp_oauth_token_ref. To force a full Google re-auth, the user clicks
// "Reconnect" on the Google Analytics card (which re-runs OAuth with
// select_account prompt).
router.post('/sites/:siteId/gbp/disconnect', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { full } = req.query; // ?full=1 to nuke the OAuth token too
  try {
    const pool = await getServicesPool();
    if (full === '1' || full === 'true') {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query(`
          UPDATE arion.site
          SET gbp_connected = 0,
              gbp_oauth_token_ref = NULL,
              gbp_location_name = NULL,
              gbp_place_id = NULL
          WHERE tenant_id = @tenantId AND site_id = @siteId
        `);
    } else {
      // Default: only clear GBP-specific selection (keep OAuth for GA/GSC)
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query(`
          UPDATE arion.site
          SET gbp_location_name = NULL,
              gbp_place_id = NULL
          WHERE tenant_id = @tenantId AND site_id = @siteId
        `);
    }
    res.json({ data: { disconnected: true, mode: full ? 'full' : 'location_only' }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[gbp/disconnect]', err);
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
  // v2.0.13: force account picker (select_account) so users can switch Google
  // accounts when reconnecting — was reusing the previously-signed-in account.
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, access_type: 'offline', prompt: 'select_account consent' });
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
    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (!tier) return res.status(400).json({ error: { code: 'NO_TIER', message: 'Site has no seo_addon_tier — purchase an SEO add-on first.', status: 400 } });

    const { configureForTier, persistResult } = await import('../lib/seoOnboarding.js');
    const result = await configureForTier(site, tier);
    if (result.projectId) await persistResult(pool, tenantId, siteId, result);

    const integrationId = crypto.randomUUID();
    res.json({
      integration: {
        siteIntegrationId: integrationId, providerCode: 'se_ranking',
        status: result.ok ? 'active' : 'partial',
        config: { tier, projectId: result.projectId, ...result.config },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      snapshot: { errors: result.errors, manual_steps: result.manual_steps },
    });
  } catch (err) {
    console.error('[arion/seo/project/create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/provision-code — admin mint a provisioning code +
// return three install paths (WP-CLI zero-touch, magic link, manual paste).
router.post('/sites/:siteId/provision-code', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const { ttl_days } = req.body || {};
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const { createProvisionCode } = await import('../lib/provisionCodes.js');
    const result = await createProvisionCode(pool, {
      tenantId, siteId, createdBy: req.user?.email || req.user?.userId || null,
      ttlDays: Number(ttl_days) > 0 ? Number(ttl_days) : 7,
    });

    // The plugin auto-redeem reads option `ia_pending_provision_code` on
    // admin_init. WP-CLI snippet pre-seeds that option during Hostinger
    // first-boot so the plugin self-configures on first admin pageview.
    const wpCliSnippet = `wp option update ia_pending_provision_code "${result.code}" --autoload=yes`;
    const wpCliAlternate = `wp eval 'update_option("ia_pending_provision_code", "${result.code}", true);'`;
    const magicLink = `${site.primary_url ? site.primary_url.replace(/\/+$/, '') : `https://${site.domain}`}/wp-admin/admin.php?page=ia-arion&ia_provision=${encodeURIComponent(result.code)}`;

    res.status(201).json({
      data: {
        code: result.code,
        code_id: result.code_id,
        expires_at: result.expires_at,
        install_options: {
          zero_touch_wp_cli: wpCliSnippet,
          zero_touch_wp_cli_alt: wpCliAlternate,
          magic_link: magicLink,
          manual_code: result.code,
        },
        site: { id: site.site_id, domain: site.domain, primary_url: site.primary_url },
      },
    });
  } catch (err) {
    console.error('[arion/sites/:siteId/provision-code]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/seo/project/reconfigure — re-run onboarding when tier changes
router.post('/seo/project/reconfigure', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (!tier) return res.status(400).json({ error: { code: 'NO_TIER', message: 'No seo_addon_tier on site' } });
    const { configureForTier, persistResult } = await import('../lib/seoOnboarding.js');
    const result = await configureForTier(site, tier);
    if (result.projectId) await persistResult(pool, tenantId, siteId, result);
    res.json({ ok: result.ok, tier, config: result.config, projectId: result.projectId, errors: result.errors, manual_steps: result.manual_steps });
  } catch (err) {
    console.error('[arion/seo/project/reconfigure]', err);
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
// SE Ranking — Keyword research + keyword management (2026-06-17 productization)
//
// These routes enable self-serve and founder-admin SEO project setup beyond
// the audit-only flow. Keyword research lives in serankingData.js (Data API
// key). Keyword management lives in seranking.js (Project API key).
//
// Rate limiting: per-tenant + per-day soft caps to protect Data API budget.
// Cap math:
//   Lite/Standard:  20 research calls / day
//   Pro:            50 research calls / day
//   Business+:     200 research calls / day
// Per-tenant counter lives in process memory (good enough for v1 — restart
// resets it, which is acceptable since the protection is best-effort).
// ---------------------------------------------------------------------------

const KEYWORD_RESEARCH_COUNTER = new Map(); // key: `${tenantId}:${YYYY-MM-DD}` → count
function getDailyKeywordResearchCount(tenantId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${tenantId}:${day}`;
  return KEYWORD_RESEARCH_COUNTER.get(key) || 0;
}
function bumpKeywordResearchCount(tenantId) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${tenantId}:${day}`;
  const next = (KEYWORD_RESEARCH_COUNTER.get(key) || 0) + 1;
  KEYWORD_RESEARCH_COUNTER.set(key, next);
  return next;
}
function getKeywordResearchCap(seoAddonTier) {
  // Reuses ARION SEO tier matrix vocabulary, NOT cross-product tier matrix.
  // Authority customers (paying $199/mo for SEO) get more research budget.
  const tier = String(seoAddonTier || '').toLowerCase();
  if (tier === 'authority') return 200;
  if (tier === 'growth') return 50;
  return 20;
}

// POST /arion/seo/keywords/research
// Body: { seed: string, region?: string, limit?: number }
// Returns: { overview, suggestions, related, longtail, questions }
router.post('/seo/keywords/research', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { seed, region = 'us', limit = 25, siteId } = req.body || {};
  if (!seed || typeof seed !== 'string' || seed.trim().length < 2) {
    return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'seed (string, ≥ 2 chars) required', status: 400 } });
  }
  try {
    // Rate-limit check
    let tier = 'starter';
    if (siteId) {
      const pool = await getServicesPool();
      const site = await getSiteForTenant(pool, tenantId, siteId);
      if (site) tier = site.seo_addon_tier || 'starter';
    }
    const cap = getKeywordResearchCap(tier);
    const used = getDailyKeywordResearchCount(tenantId);
    if (used >= cap) {
      return res.status(429).json({ error: { code: 'RATE_LIMIT', message: `Daily keyword research limit reached (${cap} per day on ${tier}). Resets at midnight UTC.`, status: 429, cap, used } });
    }
    bumpKeywordResearchCount(tenantId);

    const { researchKeyword } = await import('../lib/serankingData.js');
    const research = await researchKeyword(seed.trim(), { regionId: region, limit: Math.min(Number(limit) || 25, 100) });
    res.json({
      data: research,
      meta: { tier, cap, used: used + 1, remaining: cap - used - 1 },
    });
  } catch (err) {
    console.error('[arion/seo/keywords/research]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/seo/keywords/add
// Body: { siteId, keywords: string[], groupId?: number }
// Adds keywords to the site's SE Ranking project. Enforces the tier keyword cap.
router.post('/seo/keywords/add', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, keywords, groupId } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'keywords (non-empty array) required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) {
      return res.status(400).json({ error: { code: 'NO_PROJECT', message: 'Site has no SE Ranking project yet. Run /seo/project/create first.', status: 400 } });
    }

    // Tier cap check
    const TIER_CAPS = { starter: 10, essentials: 25, growth: 60, authority: 150 };
    const tier = String(site.seo_addon_tier || '').toLowerCase();
    const cap = TIER_CAPS[tier] || 0;
    const { getProjectKeywords, addKeywords } = await import('../lib/seranking.js');
    const existing = await getProjectKeywords(site.se_ranking_project_id, tenantId);
    const existingCount = Array.isArray(existing) ? existing.length : 0;
    const requested = keywords.length;
    if (cap > 0 && existingCount + requested > cap) {
      return res.status(400).json({ error: { code: 'TIER_CAP_EXCEEDED', message: `Tier ${tier} cap is ${cap} keywords. You have ${existingCount}, requested ${requested}.`, status: 400, cap, existing: existingCount, requested } });
    }

    const result = await addKeywords(site.se_ranking_project_id, keywords, { tenantId, groupId });
    res.json({ data: result, project_id: site.se_ranking_project_id });
  } catch (err) {
    console.error('[arion/seo/keywords/add]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// DELETE /arion/seo/keywords
// Body: { siteId, keywordIds: number[] }
router.delete('/seo/keywords', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, keywordIds } = req.body || {};
  if (!siteId || !Array.isArray(keywordIds) || keywordIds.length === 0) {
    return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId + keywordIds[] required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site?.se_ranking_project_id) return res.status(404).json({ error: { code: 'NO_PROJECT', message: 'No SE Ranking project for site', status: 404 } });
    const { removeKeywords } = await import('../lib/seranking.js');
    const ok = await removeKeywords(site.se_ranking_project_id, keywordIds, tenantId);
    res.json({ ok, removed: keywordIds.length });
  } catch (err) {
    console.error('[arion/seo/keywords DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/seo/keywords?siteId=...
// Returns current tracked keywords for the site's project with volume/difficulty.
router.get('/seo/keywords', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site?.se_ranking_project_id) return res.json({ data: [], project_id: null });
    const { getProjectKeywords } = await import('../lib/seranking.js');
    const keywords = await getProjectKeywords(site.se_ranking_project_id, tenantId);
    res.json({ data: keywords, project_id: site.se_ranking_project_id, tier: site.seo_addon_tier });
  } catch (err) {
    console.error('[arion/seo/keywords GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// AI Search prompt management (Growth + Authority tiers)
// ---------------------------------------------------------------------------

// AI prompt cap is 5 TOTAL per tier (revised 2026-06-17, Brandon).
// A single prompt at Authority can target multiple engines; the cap is the
// number of distinct prompts, not prompt × engine slots.
const AI_PROMPT_TIER_LIMITS = {
  starter: 0,
  essentials: 0,
  growth: 5,
  authority: 5,
};

const AI_PROMPT_ENGINES_BY_TIER = {
  starter: [],
  essentials: [],
  growth: ['ai_mode'],                       // Google AI Mode only
  authority: ['ai_mode', 'chatgpt', 'gemini'], // All three; each prompt picks subset
};

// SE Ranking AIRT base_name canonical strings (used in the API enum).
const AIRT_ENGINE_BASE_NAMES = {
  ai_mode: 'google_ai_mode',
  chatgpt: 'chatgpt',
  gemini: 'gemini',
  perplexity: 'perplexity',
  ai_overview: 'google_ai_overview',
};

const AIRT_BASE_NAME_TO_KEY = {
  google_ai_mode: 'ai_mode',
  chatgpt: 'chatgpt',
  gemini: 'gemini',
  perplexity: 'perplexity',
  google_ai_overview: 'ai_overview',
};

// GET /arion/seo/ai-prompts?siteId=...
// Returns prompts grouped by enabled LLM engine, plus tier metadata.
// Aggregates across every enabled AI engine on the project.
router.get('/seo/ai-prompts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    const tier = String(site?.seo_addon_tier || '').toLowerCase();
    const cap = AI_PROMPT_TIER_LIMITS[tier] || 0;
    const allowedEngines = AI_PROMPT_ENGINES_BY_TIER[tier] || [];

    if (!site?.se_ranking_project_id) {
      return res.json({ data: [], engines: [], brand: null, project_id: null, tier, cap, allowed_engines: allowedEngines, total_prompts: 0 });
    }

    const { getAIBrand, listAIEngines, getAllAIPrompts } = await import('../lib/seranking.js');
    const [brand, engines, byEngine] = await Promise.all([
      getAIBrand(site.se_ranking_project_id, tenantId),
      listAIEngines(site.se_ranking_project_id, tenantId),
      getAllAIPrompts(site.se_ranking_project_id, tenantId),
    ]);

    const totalPrompts = byEngine.reduce((acc, e) => acc + (Array.isArray(e.prompts) ? e.prompts.length : 0), 0);

    res.json({
      data: byEngine,             // [{ llm_id, engine_base_name, prompts:[...] }, ...]
      engines,                    // raw LLM engine list as SE Ranking returned
      brand: brand?.brand || brand || null,
      project_id: site.se_ranking_project_id,
      tier,
      cap,
      allowed_engines: allowedEngines,
      total_prompts: totalPrompts,
    });
  } catch (err) {
    console.error('[arion/seo/ai-prompts GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/seo/ai-prompts/setup
// Body: { siteId, brand? }
// One-shot: sets brand from supplied or site name, enables every AI engine
// allowed by the tier. Idempotent — skips engines already enabled.
router.post('/seo/ai-prompts/setup', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, brand: brandOverride } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site?.se_ranking_project_id) return res.status(400).json({ error: { code: 'NO_PROJECT', message: 'Site has no SE Ranking project', status: 400 } });
    const tier = String(site.seo_addon_tier || '').toLowerCase();
    const allowedEngines = AI_PROMPT_ENGINES_BY_TIER[tier] || [];
    if (allowedEngines.length === 0) {
      return res.status(403).json({ error: { code: 'TIER_NOT_AVAILABLE', message: `AI Search is available at Growth (Google AI Mode) and Authority (+ChatGPT + Gemini). Current tier: ${tier || 'none'}.`, status: 403 } });
    }

    const { setAIBrand, listAIEngines, enableAIEngine } = await import('../lib/seranking.js');
    const brand = brandOverride || site.business_name || site.domain || 'Brand';
    const brandResult = await setAIBrand(site.se_ranking_project_id, brand, tenantId);
    const existing = await listAIEngines(site.se_ranking_project_id, tenantId);
    const existingBaseNames = new Set(existing.map((e) => e.base_name));

    const enabled = [];
    const skipped = [];
    for (const engineKey of allowedEngines) {
      const baseName = AIRT_ENGINE_BASE_NAMES[engineKey];
      if (!baseName) continue;
      if (existingBaseNames.has(baseName)) {
        skipped.push(baseName);
        continue;
      }
      const result = await enableAIEngine(site.se_ranking_project_id, { baseName, countryCode: 'us', langCode: 'en' }, tenantId);
      if (result?.llm_id || result?.id) {
        enabled.push({ base_name: baseName, llm_id: result.llm_id || result.id });
      }
    }

    res.json({ brand, brand_set: !!brandResult, enabled, skipped, tier, cap: AI_PROMPT_TIER_LIMITS[tier] || 0 });
  } catch (err) {
    console.error('[arion/seo/ai-prompts/setup]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/seo/ai-prompts
// Body: { siteId, prompt, engine }
// Adds a single prompt under one engine. `engine` is one of our internal
// keys: ai_mode | chatgpt | gemini | perplexity | ai_overview.
// Enforces tier cap (5 total per project across all engines).
router.post('/seo/ai-prompts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, prompt, engine } = req.body || {};
  if (!siteId || !prompt || !engine) {
    return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId + prompt + engine required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site?.se_ranking_project_id) {
      return res.status(400).json({ error: { code: 'NO_PROJECT', message: 'Site has no SE Ranking project', status: 400 } });
    }
    const tier = String(site.seo_addon_tier || '').toLowerCase();
    const cap = AI_PROMPT_TIER_LIMITS[tier] || 0;
    if (cap === 0) {
      return res.status(403).json({ error: { code: 'TIER_NOT_AVAILABLE', message: `AI prompts require Growth or Authority tier. Current: ${tier || 'none'}.`, status: 403 } });
    }
    const allowedEngines = AI_PROMPT_ENGINES_BY_TIER[tier];
    if (!allowedEngines.includes(engine)) {
      return res.status(400).json({ error: { code: 'INVALID_ENGINE', message: `Engine ${engine} not available at tier ${tier}. Allowed: ${allowedEngines.join(', ')}.`, status: 400 } });
    }

    const { listAIEngines, getAllAIPrompts, addAIPrompt } = await import('../lib/seranking.js');

    // Resolve engine → llm_id (engine must be enabled first via /setup).
    const engines = await listAIEngines(site.se_ranking_project_id, tenantId);
    const baseName = AIRT_ENGINE_BASE_NAMES[engine];
    const targetEngine = engines.find((e) => e.base_name === baseName);
    if (!targetEngine) {
      return res.status(409).json({ error: { code: 'ENGINE_NOT_ENABLED', message: `Engine ${baseName} not yet enabled on this project. POST /seo/ai-prompts/setup first.`, status: 409 } });
    }

    // Tier cap is TOTAL across all engines (per locked tier matrix
    // revised 2026-06-17).
    const byEngine = await getAllAIPrompts(site.se_ranking_project_id, tenantId);
    const totalExisting = byEngine.reduce((acc, e) => acc + (Array.isArray(e.prompts) ? e.prompts.length : 0), 0);
    if (totalExisting >= cap) {
      return res.status(400).json({ error: { code: 'CAP_EXCEEDED', message: `AI prompt cap reached (${cap}). Remove a prompt first.`, status: 400, cap, existing: totalExisting } });
    }

    const result = await addAIPrompt(
      site.se_ranking_project_id,
      targetEngine.llm_id ?? targetEngine.id,
      [String(prompt).trim()],
      { tenantId }
    );
    if (!result) {
      return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'SE Ranking rejected the prompt.', status: 502 } });
    }
    res.json({ data: result, engine, llm_id: targetEngine.llm_id ?? targetEngine.id });
  } catch (err) {
    console.error('[arion/seo/ai-prompts POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// DELETE /arion/seo/ai-prompts/:k2siteLlmId?siteId=...&llmId=...
// Deletes one prompt by its k2site_llm_id under a specific engine.
router.delete('/seo/ai-prompts/:k2siteLlmId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, llmId } = req.query;
  const { k2siteLlmId } = req.params;
  if (!siteId || !llmId) {
    return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId + llmId query params required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site?.se_ranking_project_id) return res.status(404).json({ error: { code: 'NO_PROJECT', message: 'No SE Ranking project', status: 404 } });
    const { removeAIPrompt } = await import('../lib/seranking.js');
    const ok = await removeAIPrompt(site.se_ranking_project_id, llmId, [Number(k2siteLlmId)], tenantId);
    res.json({ ok });
  } catch (err) {
    console.error('[arion/seo/ai-prompts DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// Phase 3.5 — SE Ranking expanded routes
// ---------------------------------------------------------------------------

// Engine-metadata cache keyed by projectId. Lives in process memory — SE Ranking
// engine ids don't churn mid-session, so a 6h TTL is plenty.
const ENGINE_META_CACHE = new Map();
const ENGINE_META_TTL_MS = 6 * 60 * 60 * 1000;

// Global catalog cache — /system/search-engines returns 4,000+ entries, rarely
// changes. Fetch once per hour per process.
let SYSTEM_ENGINE_CATALOG = null;
let SYSTEM_ENGINE_CATALOG_TS = 0;
const SYSTEM_ENGINE_CATALOG_TTL_MS = 60 * 60 * 1000;

async function getSystemEngineCatalog() {
  if (SYSTEM_ENGINE_CATALOG && Date.now() - SYSTEM_ENGINE_CATALOG_TS < SYSTEM_ENGINE_CATALOG_TTL_MS) {
    return SYSTEM_ENGINE_CATALOG;
  }
  const r = await seRankingRaw('GET', '/system/search-engines');
  const catalog = {};
  if (r.ok && Array.isArray(r.data)) {
    for (const e of r.data) catalog[String(e.id)] = e; // { id, name, region_id, type }
  }
  SYSTEM_ENGINE_CATALOG = catalog;
  SYSTEM_ENGINE_CATALOG_TS = Date.now();
  return catalog;
}

async function loadEngineMetaForProject(projectId, site_engine_ids) {
  const cached = ENGINE_META_CACHE.get(String(projectId));
  if (cached && Date.now() - cached.ts < ENGINE_META_TTL_MS) return cached.map;

  // Real metadata via two SE Ranking endpoints:
  //   /sites/{projectId}/search-engines  → per-project engines with
  //       { site_engine_id, search_engine_id, region_name, lang_code }
  //   /system/search-engines             → global catalog with
  //       { id, name, region_id, type }  where type ∈ google, google_mobile, bing, ...
  // Join produces proper labels like "Google USA · Des Moines, Iowa · EN".
  const [projectEnginesRaw, catalog] = await Promise.all([
    seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/search-engines`),
    getSystemEngineCatalog(),
  ]);

  const projectEngines = projectEnginesRaw.ok && Array.isArray(projectEnginesRaw.data)
    ? projectEnginesRaw.data
    : [];

  const map = {};
  for (const pe of projectEngines) {
    const siteEngineId = String(pe.site_engine_id);
    const catEntry = catalog[String(pe.search_engine_id)] || null;
    const catName = catEntry?.name || null;        // e.g. "Google USA", "Google Mobile USA", "Bing USA (English)"
    const catType = catEntry?.type || null;        // e.g. "google", "google_mobile", "bing", "chatgpt"
    const region = pe.region_name || null;          // e.g. "Des Moines, Iowa, United States"
    const lang = pe.lang_code ? pe.lang_code.toUpperCase() : null;

    // Infer brand + device from catalog `type`. Covers standard engines AND
    // AI engines (chatgpt, gemini, ai_overview, ai_mode, perplexity) without
    // special-casing — the type field is the source of truth.
    const isAi = ['chatgpt', 'gemini', 'perplexity', 'ai_overview', 'ai_mode', 'aiMode', 'aimode', 'claude'].includes(catType);
    const isMobile = catType && catType.includes('mobile');
    const brand = catType === 'google' || catType === 'google_mobile' ? 'Google'
               : catType === 'bing' || catType === 'bing_mobile' ? 'Bing'
               : isAi ? (catName || catType)
               : (catName || catType || `Engine ${siteEngineId}`);

    // Short label for hero cards: "Google Desktop", "Google Mobile", "Bing",
    // "ChatGPT", "Gemini", etc.
    const shortLabel = brand === 'Google' ? `Google ${isMobile ? 'Mobile' : 'Desktop'}`
                     : brand === 'Bing' ? 'Bing'
                     : brand;

    // Long label for tooltips / detail views: brand + region + lang
    const parts = [catName || brand];
    if (region) parts.push(region);
    if (lang) parts.push(lang);
    const longLabel = parts.filter(Boolean).join(' · ');

    map[siteEngineId] = {
      id: siteEngineId,
      name: brand,
      catalogName: catName,
      type: catType,
      device: isMobile ? 'mobile' : (isAi ? 'ai' : 'desktop'),
      region,
      lang,
      isAi,
      label: shortLabel,
      longLabel,
      canonical: false,  // real data from SE Ranking, not a guess
    };
  }

  // Fallback for any engine id in site_engine_ids but missing from
  // /sites/{id}/search-engines response (shouldn't happen but guard anyway).
  for (const id of (site_engine_ids || []).map(String)) {
    if (!map[id]) map[id] = { id, name: null, label: `Engine ${id}`, longLabel: `Engine ${id}`, canonical: true };
  }

  ENGINE_META_CACHE.set(String(projectId), { ts: Date.now(), map });
  return map;
}

// --- GET /arion/seo/rankings?siteId=&range=30d&provider=all|google|bing&device=all|desktop|mobile ---
// Normalized keyword ranking list with REAL keyword names (joins
// /positions with /keywords so blank name fields don't come through).
router.get('/seo/rankings', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const rangeCode = (req.query.range || '30d').toString().toLowerCase();
  const providerFilter = (req.query.provider || 'all').toString().toLowerCase();
  const deviceFilter = (req.query.device || 'all').toString().toLowerCase();
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) {
      return res.json({ connected: false, keywords: [], projectId: null });
    }

    const projectId = site.se_ranking_project_id;
    const range = resolveRange(rangeCode);

    // Fetch both current-period and prior-period positions so we can compute
    // period-over-period stat deltas without a second deploy cycle.
    const [curRaw, priorRaw] = await Promise.all([
      seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.current.start}&date_to=${range.current.end}`),
      seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.prior.start}&date_to=${range.prior.end}`),
    ]);
    const curBlocks = Array.isArray(curRaw.data) ? curRaw.data : [];
    const priorBlocks = Array.isArray(priorRaw.data) ? priorRaw.data : [];

    const upstreamError = !curRaw.ok
      ? { positions: `HTTP ${curRaw.status}: ${curRaw.errorText || 'unknown'}`, keyConfigured: curRaw.keyConfigured }
      : null;

    // Load engine metadata (cached per-project). Without this, engines fall
    // back to "Engine {id}" labels but the data model still works.
    const engineIds = Array.from(new Set(curBlocks.map((b) => String(b.site_engine_id))));
    const engineMetaById = await loadEngineMetaForProject(projectId, engineIds).catch(() => ({}));

    // Build engine-id filter from provider/device query params + metadata map.
    const engineFilter = new Set();
    for (const id of engineIds) {
      const meta = engineMetaById[id];
      const matchesProvider = providerFilter === 'all'
        || (meta?.name && meta.name.toLowerCase().includes(providerFilter));
      const matchesDevice = deviceFilter === 'all'
        || (meta?.device && meta.device.toLowerCase() === deviceFilter);
      if (matchesProvider && matchesDevice) engineFilter.add(id);
    }
    // Safety: if engineFilter is empty (metadata not yet resolved), fall back to all.
    const effectiveFilter = engineFilter.size ? engineFilter : null;

    const keywords = parsePositions(curBlocks, {
      rangeStart: range.current.start,
      rangeEnd: range.current.end,
      engineFilter: effectiveFilter,
      engineMetaById,
    }).sort((a, b) => (a.currentPosition ?? 9999) - (b.currentPosition ?? 9999));

    const priorKeywords = parsePositions(priorBlocks, {
      rangeStart: range.prior.start,
      rangeEnd: range.prior.end,
      engineFilter: effectiveFilter,
      engineMetaById,
    });

    const stats = computeAggregateStats(keywords);
    const priorStats = computeAggregateStats(priorKeywords);

    const delta = (cur, prev) => (cur == null || prev == null ? null : Math.round((cur - prev) * 10) / 10);

    // Daily distribution series for the Rankings-page "Distribution of top
    // positions" chart. Respects the engine filter so the chart shows only
    // the selected engine's trend when user toggles.
    const filteredCurBlocks = effectiveFilter
      ? curBlocks.filter((b) => effectiveFilter.has(String(b.site_engine_id)))
      : curBlocks;
    const distributionSeries = buildDistributionSeries(filteredCurBlocks, range.current.start, range.current.end);

    res.json({
      connected: true,
      projectId,
      range: { code: rangeCode, label: range.label, current: range.current, prior: range.prior, days: range.days },
      filters: { provider: providerFilter, device: deviceFilter },
      engines: {
        metadata: Object.values(engineMetaById),
        availableIds: engineIds,
        filteredIds: Array.from(effectiveFilter || engineIds),
      },
      stats: {
        current: stats,
        prior: priorStats,
        delta: {
          avgPosition: delta(stats.avgPosition, priorStats.avgPosition),
          visibilityScore: delta(stats.visibilityScore, priorStats.visibilityScore),
          top10Count: delta(stats.top10Count, priorStats.top10Count),
          trafficForecast: delta(stats.trafficForecast, priorStats.trafficForecast),
          totalKeywords: delta(stats.totalKeywords, priorStats.totalKeywords),
          rankingKeywords: delta(stats.rankingKeywords, priorStats.rankingKeywords),
        },
      },
      keywords,
      distributionSeries,
      upstreamError,
    });
  } catch (err) {
    console.error('[arion/seo/rankings]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/overview?siteId=&range=30d ---
// Expansive SEO overview: rolls up rankings + distribution + movers +
// period-over-period deltas + per-engine bucket counts for the hero cards.
// Phase 3.5 landing endpoint.
router.get('/seo/overview', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const rangeCode = (req.query.range || '30d').toString().toLowerCase();
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) {
      return res.json({ connected: false, projectId: null });
    }

    const projectId = site.se_ranking_project_id;
    const range = resolveRange(rangeCode);

    const [curRaw, priorRaw] = await Promise.all([
      seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.current.start}&date_to=${range.current.end}`),
      seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.prior.start}&date_to=${range.prior.end}`),
    ]);
    const curBlocks = Array.isArray(curRaw.data) ? curRaw.data : [];
    const priorBlocks = Array.isArray(priorRaw.data) ? priorRaw.data : [];

    const engineIds = Array.from(new Set(curBlocks.map((b) => String(b.site_engine_id))));
    const engineMetaById = await loadEngineMetaForProject(projectId, engineIds).catch(() => ({}));

    const curKeywords = parsePositions(curBlocks, { rangeStart: range.current.start, rangeEnd: range.current.end, engineMetaById });
    const priorKeywords = parsePositions(priorBlocks, { rangeStart: range.prior.start, rangeEnd: range.prior.end, engineMetaById });
    const stats = computeAggregateStats(curKeywords);
    const priorStats = computeAggregateStats(priorKeywords);

    // Per-engine hero cards — one card per site_engine_id so the UI can show
    // "Google Desktop" / "Google Mobile" / "Bing" as SEPARATE cards (not
    // grouped under a single "Google" brand card). AI engines are separated
    // from standard engines via the meta.isAi flag.
    const computeEngineStats = (engineId) => {
      const filter = new Set([engineId]);
      const kw = parsePositions(curBlocks, { rangeStart: range.current.start, rangeEnd: range.current.end, engineFilter: filter, engineMetaById });
      const prior = parsePositions(priorBlocks, { rangeStart: range.prior.start, rangeEnd: range.prior.end, engineFilter: filter, engineMetaById });
      const cur = computeAggregateStats(kw);
      const pri = computeAggregateStats(prior);
      return {
        current: cur,
        prior: pri,
        avgPositionDelta: cur.avgPosition != null && pri.avgPosition != null ? Math.round((pri.avgPosition - cur.avgPosition) * 10) / 10 : null,
        visibilityDelta: cur.visibilityScore - pri.visibilityScore,
        top10Delta: cur.top10Count - pri.top10Count,
      };
    };

    const standardCards = [];
    const aiCards = [];
    for (const engineId of engineIds) {
      const meta = engineMetaById[engineId];
      const card = {
        engineId,
        name: meta?.name || `Engine ${engineId}`,
        label: meta?.label || `Engine ${engineId}`,
        longLabel: meta?.longLabel || meta?.label || `Engine ${engineId}`,
        type: meta?.type || null,
        device: meta?.device || null,
        region: meta?.region || null,
        lang: meta?.lang || null,
        ...computeEngineStats(engineId),
      };
      if (meta?.isAi) aiCards.push(card);
      else standardCards.push(card);
    }

    // AI engines live in a SEPARATE SE Ranking subsystem (AI Result Tracker)
    // and are NOT returned by /sites/{id}/positions or /sites/{id}/search-engines.
    // Fetch /sites/{id}/airt/llm to populate AI cards with real engine
    // metadata. Per-LLM statistics (mentions / link presence) require
    // /airt/llm/{id}/statistics — wired in V2.
    try {
      const airtRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/airt/llm`);
      if (airtRaw.ok && Array.isArray(airtRaw.data)) {
        for (const llm of airtRaw.data) {
          const baseName = String(llm.base_name || '').toLowerCase();
          const aiLabel = baseName === 'chatgpt' ? 'ChatGPT'
                        : baseName === 'gemini' ? 'Gemini'
                        : baseName === 'ai_mode' || baseName === 'aimode' ? 'AI Mode'
                        : baseName === 'perplexity' ? 'Perplexity'
                        : baseName === 'ai_overview' || baseName === 'aioverview' ? 'AI Overview'
                        : llm.base_name || `AI ${llm.id}`;
          const region = llm.region_name || null;
          const lang = llm.lang_code ? String(llm.lang_code).toUpperCase() : null;
          const longParts = [aiLabel];
          if (region) longParts.push(region);
          if (lang) longParts.push(lang);
          aiCards.push({
            engineId: String(llm.id),
            name: aiLabel,
            label: aiLabel,
            longLabel: longParts.join(' · '),
            type: baseName,
            device: 'ai',
            region,
            lang,
            // Placeholders until /airt/llm/{id}/statistics is wired
            current: {
              avgPosition: null,
              visibilityScore: 0,
              top10Count: null,
              trafficForecast: 0,
              totalKeywords: null,
              rankingKeywords: null,
              movers: { jumped: 0, dropped: 0, unchanged: 0 },
              buckets: { top1: 0, top2_3: 0, top4_5: 0, top6_10: 0, top11_30: 0, top31_100: 0, notRanking: 0 },
            },
            prior: { avgPosition: null, visibilityScore: 0, top10Count: null, trafficForecast: 0, totalKeywords: null, rankingKeywords: null, movers: { jumped: 0, dropped: 0, unchanged: 0 }, buckets: { top1: 0, top2_3: 0, top4_5: 0, top6_10: 0, top11_30: 0, top31_100: 0, notRanking: 0 } },
            avgPositionDelta: null,
            visibilityDelta: 0,
            top10Delta: 0,
            placeholder: true,  // UI flag — indicates stats haven't been wired yet
          });
        }
      }
    } catch (e) {
      console.warn('[arion/seo/overview] AI engine fetch failed:', e.message);
    }

    // Keyword movers (jumped / dropped) — using position change > 0 means
    // improved (lower number).
    const sortedByChange = [...curKeywords].sort((a, b) => Number(b.positionChange || 0) - Number(a.positionChange || 0));
    const topJumped = sortedByChange.slice(0, 10).filter((k) => k.positionChange > 0).map(toMoverRow);
    const topDropped = [...sortedByChange].reverse().slice(0, 10).filter((k) => k.positionChange < 0).map(toMoverRow);

    // Daily distribution series for the stacked-area chart on the Overview.
    const distributionSeries = buildDistributionSeries(curBlocks, range.current.start, range.current.end);

    // Cross-section widgets: audit score, recent backlinks (Data API placeholder)
    // Audit score just surfaces what's stored on site row (we don't re-call
    // SE Ranking audit here to keep latency low). Audit page does the full pull.
    res.json({
      connected: true,
      projectId,
      range: { code: rangeCode, label: range.label, current: range.current, prior: range.prior, days: range.days },
      engines: { metadata: Object.values(engineMetaById), availableIds: engineIds },
      heroCards: {
        // Legacy brand-grouped array kept for any callers still using it.
        providers: standardCards,
        // New per-engine arrays — UI should prefer these.
        standard: standardCards,
        ai: aiCards,
      },
      stats: {
        current: stats,
        prior: priorStats,
        delta: {
          avgPosition: stats.avgPosition != null && priorStats.avgPosition != null ? Math.round((priorStats.avgPosition - stats.avgPosition) * 10) / 10 : null,
          visibilityScore: Math.round((stats.visibilityScore - priorStats.visibilityScore) * 10) / 10,
          top10Count: stats.top10Count - priorStats.top10Count,
          trafficForecast: stats.trafficForecast - priorStats.trafficForecast,
          totalKeywords: stats.totalKeywords - priorStats.totalKeywords,
          rankingKeywords: stats.rankingKeywords - priorStats.rankingKeywords,
        },
      },
      movers: { jumped: topJumped, dropped: topDropped, unchanged: stats.movers.unchanged },
      distributionSeries,
    });
  } catch (err) {
    console.error('[arion/seo/overview]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

function toMoverRow(k) {
  return {
    keywordId: k.keywordId,
    keyword: k.keyword,
    currentPosition: k.currentPosition,
    previousPosition: k.previousPosition,
    positionChange: k.positionChange,
    searchVolume: k.searchVolume,
  };
}

function buildDistributionSeries(engineBlocks, startDate, endDate) {
  // For each date in range, count keywords in each position bucket across engines.
  const byDate = {};
  for (const engine of engineBlocks || []) {
    for (const kw of engine.keywords || []) {
      for (const p of kw.positions || []) {
        if (!p?.date) continue;
        if (startDate && p.date < startDate) continue;
        if (endDate && p.date > endDate) continue;
        if (!byDate[p.date]) byDate[p.date] = { date: p.date, top1: 0, top2_3: 0, top4_5: 0, top6_10: 0, top11_30: 0, top31_100: 0, notRanking: 0 };
        const pos = Number(p.pos || 0);
        if (pos === 0) byDate[p.date].notRanking++;
        else if (pos === 1) byDate[p.date].top1++;
        else if (pos <= 3) byDate[p.date].top2_3++;
        else if (pos <= 5) byDate[p.date].top4_5++;
        else if (pos <= 10) byDate[p.date].top6_10++;
        else if (pos <= 30) byDate[p.date].top11_30++;
        else byDate[p.date].top31_100++;
      }
    }
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// --- GET /arion/seo/keyword/:keywordId?siteId=&range=90d ---
// Returns the full per-engine time series + metadata for a single keyword,
// used by the Keyword Rankings detail modal.
router.get('/seo/keyword/:keywordId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const keywordId = String(req.params.keywordId || '');
  const rangeCode = (req.query.range || '90d').toString().toLowerCase();
  if (!siteId || !keywordId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId and keywordId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.json({ connected: false });

    const projectId = site.se_ranking_project_id;
    const range = resolveRange(rangeCode);
    const posRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${range.current.start}&date_to=${range.current.end}`);
    const blocks = Array.isArray(posRaw.data) ? posRaw.data : [];
    const engineIds = Array.from(new Set(blocks.map((b) => String(b.site_engine_id))));
    const engineMetaById = await loadEngineMetaForProject(projectId, engineIds).catch(() => ({}));

    const parsed = parsePositions(blocks, {
      rangeStart: range.current.start,
      rangeEnd: range.current.end,
      engineMetaById,
    });
    const record = parsed.find((k) => String(k.keywordId) === keywordId);
    if (!record) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Keyword not in project', status: 404 } });

    res.json({
      connected: true,
      projectId,
      range: { code: rangeCode, label: range.label, current: range.current, days: range.days },
      keyword: record,
    });
  } catch (err) {
    console.error('[arion/seo/keyword]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/audit?siteId=&force=true ---
// Auto-starts an audit if none exists for the project. Returns either:
//   { status: 'running', message } — audit in progress, retry in ~60s
//   { status: 'complete', healthScore, pagesCrawled, issues: {...}, issuesByCategory: [...] }
router.get('/seo/audit', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const force = String(req.query.force || '').toLowerCase() === 'true';
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) {
      return res.json({ connected: false, status: 'not_connected' });
    }

    const projectId = site.se_ranking_project_id;
    let auditId = site.se_ranking_audit_id || null;

    // Always fetch project detail so we can pick up SE Ranking's own .audit_id
    // if one exists there but isn't mirrored on our site row yet.
    const projectDetailRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}`);
    if (projectDetailRaw.ok && projectDetailRaw.data) {
      const detailAuditId = projectDetailRaw.data.audit_id || projectDetailRaw.data.site_audit_id || null;
      if (detailAuditId && String(detailAuditId) !== String(auditId)) {
        auditId = String(detailAuditId);
        try {
          await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('siteId', sql.UniqueIdentifier, siteId)
            .input('auditId', sql.NVarChar(50), auditId)
            .query('UPDATE arion.site SET se_ranking_audit_id = @auditId, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND site_id = @siteId');
        } catch (e) { console.warn('[arion/seo/audit] could not persist audit id:', e.message); }
      }
    }

    let audit = null;
    let auditRaw = null;

    // Confirmed via diagnostic 2026-04-18: the real path is /audit/{projectId}
    // (NOT /site-audit/audits/{auditId}). Audit is keyed by project, not a
    // separate audit id. Response shape:
    //   { total_pages, total_warnings, total_errors, total_passed,
    //     status: "finished"|..., start_time, audit_time }
    auditRaw = await seRankingRaw('GET', `/audit/${encodeURIComponent(projectId)}`);
    if (auditRaw.ok) audit = auditRaw.data;

    // Fetch /audit/list in parallel so we can extract the REAL SE Ranking
    // health score (stats.score) — the /audit/{id} overview above does NOT
    // include the score field. List response includes stats.score + prev_stats
    // for built-in period-over-period deltas. Confirmed working 2026-04-20.
    const auditListRaw = await seRankingRaw('GET', '/audit/list').catch(() => null);
    let listItem = null;
    if (auditListRaw?.ok && Array.isArray(auditListRaw.data?.items)) {
      listItem = auditListRaw.data.items.find((it) => String(it.id) === String(auditId))
        || auditListRaw.data.items.find((it) => String(it.site_id) === String(projectId));
    }

    // No audit on file, stored id invalid, or force=true — start a new one.
    if (!audit) {
      const started = await startSiteAudit(projectId, tenantId);
      if (started && (started.id || started.audit_id)) {
        auditId = String(started.id || started.audit_id);
        try {
          await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .input('siteId', sql.UniqueIdentifier, siteId)
            .input('auditId', sql.NVarChar(50), auditId)
            .query('UPDATE arion.site SET se_ranking_audit_id = @auditId, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND site_id = @siteId');
        } catch (e) { console.warn('[arion/seo/audit] could not persist audit id:', e.message); }
        return res.json({
          connected: true,
          status: 'running',
          auditId,
          message: 'Audit in progress — check back in 60 seconds',
        });
      }
      return res.json({
        connected: true,
        status: 'unavailable',
        message: 'Unable to start audit. Please try again in a few minutes.',
        upstreamError: {
          projectDetail: projectDetailRaw.ok ? null : `HTTP ${projectDetailRaw.status}: ${projectDetailRaw.errorText || 'unknown'}`,
          auditFetch: auditRaw && !auditRaw.ok ? `HTTP ${auditRaw.status}: ${auditRaw.errorText || 'unknown'}` : null,
          keyConfigured: projectDetailRaw.keyConfigured,
        },
      });
    }

    // Audit may still be running per SE Ranking's state machine.
    if (audit.status && String(audit.status).toLowerCase() !== 'finished' && String(audit.status).toLowerCase() !== 'complete' && String(audit.status).toLowerCase() !== 'done') {
      return res.json({
        connected: true,
        status: 'running',
        projectId,
        message: 'Audit in progress — check back in 60 seconds',
      });
    }

    const errors = Number(audit.total_errors ?? 0);
    const warnings = Number(audit.total_warnings ?? 0);
    const notices = Number(audit.total_notices ?? 0);
    const passed = Number(audit.total_passed ?? 0);
    const pagesCrawled = Number(audit.total_pages ?? 0);
    const issues = { errors, warnings, notices, passed, total: errors + warnings + notices };

    // Health score — prefer the real score from /audit/list. Fall back to our
    // severity-weighted approximation only if the list call failed.
    let healthScore = null;
    let healthScoreSource = null;
    let prevStats = null;

    if (listItem?.stats && typeof listItem.stats.score === 'number') {
      healthScore = Math.round(listItem.stats.score);
      healthScoreSource = 'se_ranking_official';
      prevStats = listItem.prev_stats ?? null;
    } else {
      // Fallback: severity-weighted approximation
      const totalChecks = errors + warnings + notices + passed;
      if (totalChecks > 0) {
        const weightedDeduction = (errors * 10 + warnings * 2 + notices * 0.5);
        const maxDeduction = totalChecks * 10;
        healthScore = Math.max(0, Math.min(100, Math.round((1 - weightedDeduction / maxDeduction) * 100)));
      } else {
        healthScore = 0;
      }
      healthScoreSource = 'ia_weighted_fallback';
    }

    // Page health ratio — approximation from error+warning count, refined
    // below with real per-page data from /audit/{id}/pages when that fetch
    // succeeds. Uses `let` so the detail-fetch block can override.
    let pagesWithIssues = Math.min(pagesCrawled, errors + warnings);
    let pagesHealthy = Math.max(0, pagesCrawled - pagesWithIssues);

    // Delta values from prev_stats (populated by SE Ranking after 2+ audits)
    const deltas = prevStats ? {
      healthScore: (listItem.stats?.score ?? 0) - (prevStats.score ?? 0),
      errors: (listItem.stats?.errors ?? 0) - (prevStats.errors ?? 0),
      warnings: (listItem.stats?.warnings ?? 0) - (prevStats.warnings ?? 0),
      notices: (listItem.stats?.notices ?? 0) - (prevStats.notices ?? 0),
      crawled: (listItem.stats?.crawled ?? 0) - (prevStats.crawled ?? 0),
    } : null;

    // Historical snapshots — call /audit/{id}/history for comparison dates.
    // Tier-gated by the caller (UI decides which dates to show based on tier).
    // We fetch up to 4 snapshots (current / 7d / 30d / 90d ago) and let the
    // UI hide the ones outside the user's tier.
    const today = new Date();
    const dates = [
      { key: 'current', date: today.toISOString().split('T')[0] },
      { key: 'weekly',  date: new Date(today.getTime() - 7  * 86400000).toISOString().split('T')[0] },
      { key: 'monthly', date: new Date(today.getTime() - 30 * 86400000).toISOString().split('T')[0] },
      { key: 'quarterly', date: new Date(today.getTime() - 90 * 86400000).toISOString().split('T')[0] },
    ];
    const historySnapshots = {};
    const histId = auditId || projectId;
    if (histId) {
      await Promise.all(dates.map(async ({ key, date }) => {
        try {
          const histRaw = await seRankingRaw('GET', `/audit/${encodeURIComponent(histId)}/history?date=${date}`);
          if (histRaw.ok && histRaw.data && !Array.isArray(histRaw.data)) {
            const d = histRaw.data;
            historySnapshots[key] = {
              date,
              auditTime: d.audit_time || null,
              pagesCrawled: d.total_pages ?? null,
              errors: d.total_errors ?? null,
              warnings: d.total_warnings ?? null,
              notices: d.total_notices ?? null,
              passed: d.total_passed ?? null,
              // pages_data has per-issue counts we'll expose later
              issueCounts: d.pages_data ?? null,
            };
          }
        } catch (e) {
          // Missing snapshots are OK — UI handles null gracefully
        }
      }));
    }

    // Top issues — fetch and surface the top 5 by count. Best-effort:
    // /audit/{id}/issues may time out on large projects, so fail soft.
    let topIssues = [];
    const issuesId = auditId || projectId;
    if (issuesId) {
      try {
        const issuesRaw = await Promise.race([
          seRankingRaw('GET', `/audit/${encodeURIComponent(issuesId)}/issues`),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, timedOut: true }), 8000)),
        ]);
        if (issuesRaw.ok && Array.isArray(issuesRaw.data?.items)) {
          topIssues = issuesRaw.data.items
            .filter((i) => Number(i.count) > 0)
            .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
            .slice(0, 5)
            .map((i) => ({
              name: i.title || i.name || i.slug || 'Issue',
              severity: (i.severity || 'warning').toLowerCase(),
              count: Number(i.count) || 0,
              slug: i.slug || null,
            }));
        }
      } catch (e) { /* non-fatal */ }
    }

    // ── Full report fetch — powers all widget sections (indexability, HTTP
    // status, CWV, domain metrics, use cases, top issues, page distribution).
    // Fetches /audit/{id}/report for section-level data AND /audit/{id}/pages
    // for per-page aggregation. Runs in parallel to keep latency low.
    let indexability = null;
    let httpStatus = null;
    let domain = null;
    let coreWebVitals = null;
    let useCases = null;
    let pageDistribution = null;
    let foundResources = null;
    let foundLinks = null;
    let realTopIssues = topIssues;  // falls back to what we already had
    let allIssues = [];           // full flat issue list for Issue Report tab
    let pagesForDetail = [];      // trimmed pages list for Crawled Pages / Found * tabs

    // Use auditId if present, otherwise fall back to projectId. SE Ranking's
    // v4 /audit endpoints are keyed by the same id that /audit/{id} accepts
    // (the project id), so the fallback is safe when the project hasn't been
    // assigned a separate audit id yet.
    const detailId = auditId || projectId;
    if (detailId) {
      try {
        const [reportRaw, pagesRaw] = await Promise.all([
          seRankingRaw('GET', `/audit/${encodeURIComponent(detailId)}/report`),
          seRankingRaw('GET', `/audit/${encodeURIComponent(detailId)}/pages`),
        ]);
        const report = reportRaw.ok ? reportRaw.data : null;
        const pagesData = pagesRaw.ok ? pagesRaw.data : null;
        const pagesArr = Array.isArray(pagesData?.items) ? pagesData.items : [];

        // ── Build flat issue list from report.sections ───────────────────
        if (report?.sections) {
          for (const sec of report.sections) {
            for (const code of Object.keys(sec.props || {})) {
              const p = sec.props[code];
              if (!p || !p.value || Number(p.value) === 0) continue;
              allIssues.push({
                slug: p.code || code,
                name: p.name || code,
                severity: String(p.status || 'warning').toLowerCase(),
                count: Number(p.value) || 0,
                category: sec.uid,
                categoryName: sec.name,
              });
            }
          }
          allIssues.sort((a, b) => b.count - a.count);
          realTopIssues = allIssues.slice(0, 10);

          // ── Most Popular Use Cases — aggregate common filter targets
          const bySlug = Object.fromEntries(allIssues.map((i) => [i.slug, i.count]));
          useCases = [
            {
              slug: 'uncrawled',
              name: 'Uncrawled pages',
              count: (bySlug.blocked_by_robots || 0) + (bySlug.blocked_by_noindex || 0) + (bySlug.blocked_by_xrobots || 0) + (bySlug.blocked_by_nofollow || 0),
            },
            {
              slug: 'non_indexable',
              name: 'Non-indexable pages',
              count: pagesArr.filter((p) => String(p.indexable) === '0' || Number(p.noindex) === 1).length,
            },
            {
              slug: 'metadata_issues',
              name: 'Pages with metadata issues',
              count: (bySlug.title_missing || 0) + (bySlug.title_duplicate || 0) + (bySlug.title_long || 0) + (bySlug.title_short || 0)
                   + (bySlug.description_missing || 0) + (bySlug.description_duplicate || 0) + (bySlug.description_long || 0) + (bySlug.description_multiple || 0),
            },
            {
              slug: 'problematic_links',
              name: 'Links to problematic pages',
              count: (bySlug.links3xx || 0) + (bySlug.extlinks3xx || 0) + (bySlug.extlinks4xx || 0) + (bySlug.extlinks_timeout || 0),
            },
            {
              slug: 'redirect_chains',
              name: 'Redirect chains and loops',
              count: (bySlug.redirect_chain || 0) + (bySlug.redirect_loop || 0) + (bySlug.canonical_chain || 0),
            },
          ];
        }

        // ── Domain metrics from report.domain_props ─────────────────────
        if (report?.domain_props) {
          const dp = report.domain_props;
          domain = {
            domainName: dp.domain || null,
            domainTrust: Number(dp.dt) || null,
            referringDomains: Number(dp.domains) || null,
            backlinks: Number(dp.backlinks) || null,
            pagesInGoogle: Number(dp.index_google) || null,
            expirationDate: dp.expdate || null,
            lastUpdated: dp.updated || null,
          };
        }

        // ── Core Web Vitals from report.sections.webvitals ──────────────
        const webvitalsSec = report?.sections?.find((s) => s.uid === 'webvitals');
        if (webvitalsSec?.props) {
          const wv = webvitalsSec.props;
          const readValue = (obj) => {
            if (!obj) return null;
            const v = Number(obj.value);
            return Number.isFinite(v) && v > 0 ? v : null;
          };
          coreWebVitals = {
            realWorld: {
              lcp: readValue(wv.chrome_ux_lcp),
              inp: readValue(wv.chrome_ux_inp),
              cls: readValue(wv.chrome_ux_cls),
              fcp: readValue(wv.chrome_ux_fcp),
            },
            lab: {
              lcp: readValue(wv.lighthouse_lcp),
              cls: readValue(wv.lighthouse_cls),
              fcp: readValue(wv.lighthouse_fcp),
              speedIndex: readValue(wv.lighthouse_speed_index),
              tti: readValue(wv.lighthouse_tti),
              tbt: readValue(wv.lighthouse_tbt),
            },
            hasData: readValue(wv.chrome_ux_lcp) != null || readValue(wv.lighthouse_lcp) != null,
          };
        }

        // ── HTTP Status Codes from /pages aggregation ───────────────────
        if (pagesArr.length > 0) {
          const statusBuckets = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
          for (const pg of pagesArr) {
            const sc = Number(pg.status) || 0;
            if (sc >= 100 && sc < 200) statusBuckets['1xx']++;
            else if (sc >= 200 && sc < 300) statusBuckets['2xx']++;
            else if (sc >= 300 && sc < 400) statusBuckets['3xx']++;
            else if (sc >= 400 && sc < 500) statusBuckets['4xx']++;
            else if (sc >= 500 && sc < 600) statusBuckets['5xx']++;
          }
          httpStatus = {
            total: pagesArr.length,
            buckets: statusBuckets,
          };

          // ── Indexability from pages + report ──────────────────────────
          const indexable = pagesArr.filter((p) => String(p.indexable) === '1' && Number(p.noindex) === 0 && Number(p.blocked_robots) === 0).length;
          const nonIndexable = pagesArr.length - indexable;
          const blockedByMeta = pagesArr.filter((p) => Number(p.noindex) === 1).length;
          const blockedByRobots = pagesArr.filter((p) => Number(p.blocked_robots) === 1).length;
          const blockedByXRobots = pagesArr.filter((p) => p.xrobots && String(p.xrobots).includes('noindex')).length;
          const nonCanonical = pagesArr.filter((p) => p.canonical_url && p.canonical_url !== p.url).length;
          const non200 = pagesArr.filter((p) => {
            const s = Number(p.status) || 0;
            return s !== 200;
          }).length;
          indexability = {
            indexable,
            nonIndexable,
            blockedBy: {
              robotsTxt: blockedByRobots,
              metaTag: blockedByMeta,
              xRobots: blockedByXRobots,
              nonCanonical,
              non200Status: non200,
            },
          };

          // ── Page Distribution (depth, response time, redirects) ──────
          const depthBuckets = {};
          const responseBuckets = { '0-0.1s': 0, '0.1-0.5s': 0, '0.5-1s': 0, '1-3s': 0, '3s+': 0 };
          const redirectBuckets = { '0': 0, '1': 0, '2': 0, '3+': 0 };
          for (const pg of pagesArr) {
            const d = Number(pg.depth) || 0;
            depthBuckets[d] = (depthBuckets[d] || 0) + 1;
            const ms = Number(pg.load_ms) || 0;
            if (ms < 100) responseBuckets['0-0.1s']++;
            else if (ms < 500) responseBuckets['0.1-0.5s']++;
            else if (ms < 1000) responseBuckets['0.5-1s']++;
            else if (ms < 3000) responseBuckets['1-3s']++;
            else responseBuckets['3s+']++;
            const rc = Number(pg.redirect_count) || 0;
            if (rc === 0) redirectBuckets['0']++;
            else if (rc === 1) redirectBuckets['1']++;
            else if (rc === 2) redirectBuckets['2']++;
            else redirectBuckets['3+']++;
          }
          pageDistribution = { depth: depthBuckets, responseTime: responseBuckets, redirects: redirectBuckets };

          // ── Found Resources: aggregate img/css/js sizes across pages ─
          const imgCount = pagesArr.reduce((s, p) => s + (Number(p.img) || 0), 0);
          const cssSizeTotal = pagesArr.reduce((s, p) => s + (Number(p.css_size) || 0), 0);
          const jsSizeTotal = pagesArr.reduce((s, p) => s + (Number(p.js_size) || 0), 0);
          foundResources = {
            images: imgCount,
            cssSizeBytes: cssSizeTotal,
            jsSizeBytes: jsSizeTotal,
            total: imgCount, // images is best single-number proxy
          };

          // ── Found Links: internal + external aggregates ──────────────
          const totalLinks = pagesArr.reduce((s, p) => s + (Number(p.total_links) || 0), 0);
          const internalLinks = pagesArr.reduce((s, p) => s + (Number(p.outlinks_internal) || 0), 0);
          const externalLinks = pagesArr.reduce((s, p) => s + (Number(p.outlinks_external) || 0), 0);
          const nofollowLinks = pagesArr.reduce((s, p) => s + (Number(p.inlinks_nofollow) || 0), 0);
          foundLinks = {
            total: totalLinks,
            internal: internalLinks,
            external: externalLinks,
            nofollow: nofollowLinks,
          };

          // Refine page-health ratio using real indexability data
          if (indexability) {
            const pagesWithAnyIssue = pagesArr.filter((p) =>
              Number(p.errors) > 0 || Number(p.warnings) > 0
            ).length;
            // Override the approximation with real per-page data
            pagesWithIssues = pagesWithAnyIssue;
            pagesHealthy = Math.max(0, pagesArr.length - pagesWithAnyIssue);
          }

          // ── Trim page list for modal tabs (Crawled Pages / Found * / Issues)
          // Keep the fields the UI needs, drop heavy ones (content_hash, title text
          // snippets already in `title`, etc). Cap at 500 pages — most projects are
          // under that; larger projects will need pagination in a later pass.
          pagesForDetail = pagesArr.slice(0, 500).map((p) => ({
            id: p.id,
            url: p.url,
            status: Number(p.status) || 0,
            depth: Number(p.depth) || 0,
            loadMs: Number(p.load_ms) || 0,
            size: Number(p.size) || 0,
            title: p.title || null,
            titleLen: Number(p.title_len) || 0,
            description: p.description || null,
            descriptionLen: Number(p.description_len) || 0,
            h1: p.h1 || null,
            wordsCount: Number(p.words_count) || 0,
            indexable: String(p.indexable) === '1',
            noindex: Number(p.noindex) === 1,
            blockedRobots: Number(p.blocked_robots) === 1,
            canonical: p.canonical_url || null,
            // Issue counts per page
            errors: Number(p.errors) || 0,
            warnings: Number(p.warnings) || 0,
            notices: Number(p.notices) || 0,
            // Resource counts
            imgCount: Number(p.img) || 0,
            cssSize: Number(p.css_size) || 0,
            jsSize: Number(p.js_size) || 0,
            imgSize: Number(p.img_size) || 0,
            // Link counts
            totalLinks: Number(p.total_links) || 0,
            outlinksInternal: Number(p.outlinks_internal) || 0,
            outlinksExternal: Number(p.outlinks_external) || 0,
            inlinks: Number(p.inlinks) || 0,
            inlinksFollow: Number(p.inlinks_follow) || 0,
            inlinksNofollow: Number(p.inlinks_nofollow) || 0,
            redirectCount: Number(p.redirect_count) || 0,
            redirectUrl: p.redirect_url || null,
          }));
        }

        // Use report's score_percent if available (matches /audit/list)
        if (report?.score_percent && healthScoreSource !== 'se_ranking_official') {
          healthScore = Number(report.score_percent) || healthScore;
          healthScoreSource = 'se_ranking_report';
        }
      } catch (e) {
        console.warn('[arion/seo/audit] detail fetch failed:', e.message);
      }
    }

    // Top pages by issues — most-actionable pages, weighted by error severity
    const topPagesByIssues = [...pagesForDetail]
      .filter((p) => (p.errors + p.warnings + p.notices) > 0)
      .sort((a, b) => (b.errors * 2 + b.warnings + b.notices * 0.25) - (a.errors * 2 + a.warnings + a.notices * 0.25))
      .slice(0, 10)
      .map((p) => ({ id: p.id, url: p.url, errors: p.errors, warnings: p.warnings, notices: p.notices }));

    // Issue Categories — grouped by section for category-level donut
    const issueCategories = [];
    if (allIssues.length > 0) {
      const byCategory = {};
      for (const iss of allIssues) {
        const key = iss.category || 'other';
        if (!byCategory[key]) byCategory[key] = { uid: key, name: iss.categoryName || 'Other', errorsCount: 0, warningsCount: 0, noticesCount: 0 };
        if (iss.severity === 'error') byCategory[key].errorsCount += iss.count;
        else if (iss.severity === 'warning') byCategory[key].warningsCount += iss.count;
        else if (iss.severity === 'notice') byCategory[key].noticesCount += iss.count;
      }
      issueCategories.push(...Object.values(byCategory).sort((a, b) =>
        (b.errorsCount * 2 + b.warningsCount + b.noticesCount * 0.25) -
        (a.errorsCount * 2 + a.warningsCount + a.noticesCount * 0.25)
      ));
    }

    res.json({
      connected: true,
      status: 'complete',
      projectId,
      auditId: auditId || null,
      healthScore,
      healthScoreSource,
      pagesCrawled,
      pagesWithIssues,
      pagesHealthy,
      lastAuditDate: audit.audit_time || audit.start_time || null,
      nextScheduledDate: null,
      issues,
      deltas,
      history: historySnapshots,
      topIssues: realTopIssues,
      allIssues,
      pages: pagesForDetail,
      topPagesByIssues,
      issueCategories,
      indexability,
      httpStatus,
      domain,
      coreWebVitals,
      useCases,
      pageDistribution,
      foundResources,
      foundLinks,
    });
  } catch (err) {
    console.error('[arion/seo/audit]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/audit/page?siteId=&pageId= ---
// Returns FULL per-page audit detail from SE Ranking's
// /audit/{detailId}/page/{pageId} endpoint. Every field is passthrough so the
// UI can surface whatever SE Ranking exposes without backend churn per field.
router.get('/seo/audit/page', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const pageId = String(req.query.pageId || '');
  if (!siteId || !pageId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId and pageId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.json({ connected: false, status: 'not_connected' });

    const projectId = site.se_ranking_project_id;
    const detailId = site.se_ranking_audit_id || projectId;

    // Fetch page + optional issues list in parallel
    const [pageRaw, issuesRaw] = await Promise.all([
      seRankingRaw('GET', `/audit/${encodeURIComponent(detailId)}/page/${encodeURIComponent(pageId)}`).catch((e) => ({ ok: false, errorText: e.message })),
      seRankingRaw('GET', `/audit/${encodeURIComponent(detailId)}/page/${encodeURIComponent(pageId)}/issues`).catch(() => ({ ok: false })),
    ]);

    const errors = [];
    let page = null;
    if (pageRaw.ok && pageRaw.data) {
      page = pageRaw.data;
    } else {
      errors.push(`page fetch failed: HTTP ${pageRaw.status || 'n/a'} ${pageRaw.errorText || ''}`);
    }

    // Build issues array — from dedicated endpoint if available, else from page_issues on the page object
    let issues = [];
    if (issuesRaw.ok && Array.isArray(issuesRaw.data?.items)) {
      issues = issuesRaw.data.items.map((i) => ({
        slug: i.slug || i.code || null,
        name: i.title || i.name || i.slug || 'Issue',
        severity: String(i.severity || 'warning').toLowerCase(),
        count: Number(i.count) || 1,
        description: i.description || null,
      }));
    } else if (page?.page_issues && typeof page.page_issues === 'object') {
      for (const [slug, val] of Object.entries(page.page_issues)) {
        const v = val && typeof val === 'object' ? val : { value: val };
        issues.push({
          slug,
          name: v.name || slug,
          severity: String(v.status || v.severity || 'warning').toLowerCase(),
          count: Number(v.value ?? v.count ?? 1) || 1,
          description: v.description || null,
        });
      }
    }

    if (!page) {
      return res.json({ connected: true, status: 'unavailable', page: null, issues: [], errors });
    }

    res.json({
      connected: true,
      status: 'complete',
      projectId,
      auditId: site.se_ranking_audit_id || null,
      pageId,
      page,   // full passthrough — UI reads any field
      issues,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[arion/seo/audit/page]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/market-monitor?siteId=&windowDays=30 ---
// Reads Market Monitor data captured by the arion-func timer jobs:
//   - Moves:        diffs arion.se_ranking_position_history across the window
//   - Backlinks:    newest rows from arion.se_ranking_backlink_snapshot
//   - PageChanges:  newest rows from arion.site_page_change
//   - JobStatus:    last run per job from arion.market_monitor_job_log
//
// All four sub-feeds are returned in a single response so the UI only makes
// one request. Empty arrays + jobStatus tells the UI to show "awaiting first
// run" instead of an error.
router.get('/seo/market-monitor', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const windowDays = Math.max(1, Math.min(180, Number(req.query.windowDays || 30)));
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (tier !== 'authority') {
      return res.json({
        connected: true,
        authorityGated: true,
        tier,
        message: 'Market Monitor requires the Authority SEO tier.',
        moves: [], backlinks: { new: [], lost: [], totals: { active: 0, newThisPeriod: 0, lostThisPeriod: 0 } },
        pageChanges: [],
        jobStatus: { moves: null, backlinks: null, page_changes: null },
      });
    }

    // ── 1. Moves: largest position deltas over the window for tracked competitors.
    // Compare earliest vs latest position within the window per keyword × competitor.
    const movesRes = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('windowDays', sql.Int, windowDays)
      .query(`
        WITH windowed AS (
          SELECT keyword_id, keyword, competitor_domain, site_engine_id,
                 position, recorded_for,
                 ROW_NUMBER() OVER (PARTITION BY keyword_id, competitor_domain, site_engine_id ORDER BY recorded_for ASC)  AS rn_first,
                 ROW_NUMBER() OVER (PARTITION BY keyword_id, competitor_domain, site_engine_id ORDER BY recorded_for DESC) AS rn_last
          FROM arion.se_ranking_position_history
          WHERE site_id = @siteId
            AND recorded_for >= CAST(DATEADD(DAY, -@windowDays, SYSUTCDATETIME()) AS DATE)
            AND competitor_domain IS NOT NULL
        )
        SELECT f.keyword_id, f.keyword, f.competitor_domain, f.site_engine_id,
               f.position AS first_position, f.recorded_for AS first_date,
               l.position AS last_position, l.recorded_for AS last_date,
               ISNULL(f.position, 0) - ISNULL(l.position, 0) AS position_change
        FROM windowed f
        JOIN windowed l
          ON  l.keyword_id = f.keyword_id
          AND l.competitor_domain = f.competitor_domain
          AND l.site_engine_id = f.site_engine_id
          AND l.rn_last = 1
        WHERE f.rn_first = 1
          AND ABS(ISNULL(f.position, 0) - ISNULL(l.position, 0)) >= 5
        ORDER BY ABS(ISNULL(f.position, 0) - ISNULL(l.position, 0)) DESC
      `);

    const moves = movesRes.recordset.map((r) => ({
      keywordId: r.keyword_id,
      keyword: r.keyword,
      competitorDomain: r.competitor_domain,
      engineId: r.site_engine_id,
      firstPosition: r.first_position,
      lastPosition: r.last_position,
      positionChange: Number(r.position_change) || 0,
      direction: Number(r.position_change) > 0 ? 'up' : 'down',
      firstDate: r.first_date,
      lastDate: r.last_date,
    }));

    // ── 2. Backlinks: new + lost within window, plus totals.
    const backlinksRes = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('windowDays', sql.Int, windowDays)
      .query(`
        SELECT referring_domain, target_url, anchor_text, domain_authority,
               link_status, first_seen, last_seen, snapshot_date
        FROM arion.se_ranking_backlink_snapshot
        WHERE site_id = @siteId
          AND snapshot_date >= CAST(DATEADD(DAY, -@windowDays, SYSUTCDATETIME()) AS DATE)
        ORDER BY snapshot_date DESC, referring_domain ASC
      `);

    const newBacklinks = [];
    const lostBacklinks = [];
    const activeDomains = new Set();
    for (const b of backlinksRes.recordset) {
      const row = {
        referringDomain: b.referring_domain,
        targetUrl: b.target_url,
        anchorText: b.anchor_text,
        domainAuthority: b.domain_authority,
        firstSeen: b.first_seen,
        lastSeen: b.last_seen,
        snapshotDate: b.snapshot_date,
      };
      if (b.link_status === 'new') newBacklinks.push(row);
      else if (b.link_status === 'lost') lostBacklinks.push(row);
      else if (b.link_status === 'active') activeDomains.add(b.referring_domain);
    }

    // ── 3. Page Changes: most recent diffs within window.
    const pcRes = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('windowDays', sql.Int, windowDays)
      .query(`
        SELECT TOP 200 page_url, page_type, competitor_domain,
               change_magnitude, excerpt_prev, excerpt_new,
               title_prev, title_new, detected_at
        FROM arion.site_page_change
        WHERE site_id = @siteId
          AND detected_at >= DATEADD(DAY, -@windowDays, SYSUTCDATETIME())
        ORDER BY detected_at DESC
      `);
    const pageChanges = pcRes.recordset.map((p) => ({
      pageUrl: p.page_url,
      pageType: p.page_type,
      competitorDomain: p.competitor_domain,
      changeMagnitude: Number(p.change_magnitude) || 0,
      excerptPrev: p.excerpt_prev,
      excerptNew: p.excerpt_new,
      titlePrev: p.title_prev,
      titleNew: p.title_new,
      detectedAt: p.detected_at,
    }));

    // ── 4. Job status: last run per job
    const jobStatusRes = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT job_name, status, rows_processed, started_at, completed_at
        FROM (
          SELECT job_name, status, rows_processed, started_at, completed_at,
                 ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
          FROM arion.market_monitor_job_log
          WHERE site_id = @siteId
        ) t
        WHERE rn = 1
      `);
    const jobStatus = { moves: null, backlinks: null, page_changes: null };
    for (const j of jobStatusRes.recordset) {
      jobStatus[j.job_name] = {
        status: j.status,
        rowsProcessed: j.rows_processed,
        startedAt: j.started_at,
        completedAt: j.completed_at,
      };
    }

    res.json({
      connected: true,
      authorityGated: false,
      tier,
      windowDays,
      moves,
      backlinks: {
        new: newBacklinks,
        lost: lostBacklinks,
        totals: {
          active: activeDomains.size,
          newThisPeriod: newBacklinks.length,
          lostThisPeriod: lostBacklinks.length,
        },
      },
      pageChanges,
      jobStatus,
    });
  } catch (err) {
    console.error('[arion/seo/market-monitor]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Market Monitor — Watchlist management + suggestions
// ──────────────────────────────────────────────────────────────────────
const MM_LIMITS = { own: 10, competitorPool: 20 };

// GET /arion/seo/market-monitor/watchlist?siteId=
// Returns the current watchlist + usage vs limits.
router.get('/seo/market-monitor/watchlist', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (tier !== 'authority') {
      return res.json({ connected: true, authorityGated: true, tier, ownPages: [], competitorPages: [], usage: { own: 0, competitor: 0, limits: MM_LIMITS } });
    }

    const r = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT watch_id, page_url, page_type, competitor_domain,
               last_content_hash, last_checked_at, last_title, enabled, created_at
        FROM arion.site_page_watch
        WHERE site_id = @siteId
        ORDER BY page_type, competitor_domain, created_at
      `);

    const ownPages = r.recordset.filter((w) => w.page_type === 'own_site');
    const competitorPages = r.recordset.filter((w) => w.page_type === 'competitor');

    res.json({
      connected: true,
      authorityGated: false,
      tier,
      ownPages: ownPages.map(mapWatchRow),
      competitorPages: competitorPages.map(mapWatchRow),
      usage: {
        own: ownPages.length,
        competitor: competitorPages.length,
        limits: MM_LIMITS,
      },
    });
  } catch (err) {
    console.error('[arion/seo/market-monitor/watchlist GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

function mapWatchRow(w) {
  return {
    watchId: String(w.watch_id),
    pageUrl: w.page_url,
    pageType: w.page_type,
    competitorDomain: w.competitor_domain,
    lastTitle: w.last_title,
    lastCheckedAt: w.last_checked_at,
    enabled: !!w.enabled,
    createdAt: w.created_at,
  };
}

// POST /arion/seo/market-monitor/watchlist
// Body: { siteId, pages: [{ pageUrl, pageType, competitorDomain? }] }
// Replaces the full watchlist atomically. Enforces tier limits and rejects
// over-limit submissions with { code: 'LIMIT_EXCEEDED' } so the UI can show
// the consulting escalation CTA.
router.post('/seo/market-monitor/watchlist', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, pages } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  if (!Array.isArray(pages)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'pages must be an array', status: 400 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (tier !== 'authority') {
      return res.status(403).json({ error: { code: 'AUTHORITY_REQUIRED', message: 'Market Monitor watchlist requires the Authority SEO tier.', status: 403 } });
    }

    // Normalize + validate + dedupe
    const normalized = [];
    const seen = new Set();
    for (const p of pages) {
      const pageUrl = typeof p?.pageUrl === 'string' ? p.pageUrl.trim() : '';
      const pageType = p?.pageType === 'competitor' ? 'competitor' : p?.pageType === 'own_site' ? 'own_site' : null;
      if (!pageUrl || !pageType) continue;
      if (!/^https?:\/\//i.test(pageUrl)) continue;
      if (pageUrl.length > 999) continue;
      if (seen.has(pageUrl)) continue;
      seen.add(pageUrl);

      const competitorDomain = pageType === 'competitor'
        ? String(p.competitorDomain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 299) || null
        : null;
      normalized.push({ pageUrl: pageUrl.slice(0, 999), pageType, competitorDomain });
    }

    const ownCount = normalized.filter((n) => n.pageType === 'own_site').length;
    const compCount = normalized.filter((n) => n.pageType === 'competitor').length;

    if (ownCount > MM_LIMITS.own || compCount > MM_LIMITS.competitorPool) {
      return res.status(422).json({
        error: {
          code: 'LIMIT_EXCEEDED',
          message: `Limit exceeded — Authority tier allows up to ${MM_LIMITS.own} own-site pages and ${MM_LIMITS.competitorPool} competitor pages. For larger watchlists, contact IA Consulting or request an Enterprise plan.`,
          status: 422,
          details: {
            submitted: { own: ownCount, competitor: compCount },
            limits: MM_LIMITS,
            escalation: {
              consultingServiceType: 'SEO Strategy',
              consultingTriggerPage: 'seo-market-monitor-watchlist',
              supportsEnterpriseInquiry: true,
            },
          },
        },
      });
    }

    // Replace watchlist atomically — delete + insert inside a transaction so
    // a failure doesn't leave the client with a half-saved watchlist.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query(`DELETE FROM arion.site_page_watch WHERE site_id = @siteId`);

      for (const n of normalized) {
        await new sql.Request(tx)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('pageUrl', sql.NVarChar(1000), n.pageUrl)
          .input('pageType', sql.NVarChar(40), n.pageType)
          .input('compDomain', sql.NVarChar(300), n.competitorDomain)
          .query(`
            INSERT INTO arion.site_page_watch
              (tenant_id, site_id, page_url, page_type, competitor_domain, enabled)
            VALUES (@tenantId, @siteId, @pageUrl, @pageType, @compDomain, 1)
          `);
      }

      await tx.commit();
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }

    res.json({
      ok: true,
      saved: normalized.length,
      usage: {
        own: ownCount,
        competitor: compCount,
        limits: MM_LIMITS,
      },
    });
  } catch (err) {
    console.error('[arion/seo/market-monitor/watchlist POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// DELETE /arion/seo/market-monitor/watchlist/:watchId?siteId=
// Single-row removal. Kept separate from bulk POST so the UI can surgically
// remove one watched page without sending the full list.
router.delete('/seo/market-monitor/watchlist/:watchId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const watchId = req.params.watchId;
  if (!siteId || !watchId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId + watchId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const r = await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('watchId', sql.BigInt, watchId)
      .query(`
        DELETE FROM arion.site_page_watch
        WHERE site_id = @siteId AND watch_id = @watchId
      `);
    res.json({ ok: true, deleted: r.rowsAffected?.[0] || 0 });
  } catch (err) {
    console.error('[arion/seo/market-monitor/watchlist DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/seo/market-monitor/suggestions?siteId=
// Returns suggested pages to watch — own-site from GSC top clicks, competitor
// pages from SE Ranking Data API /domain/overview for each tracked competitor.
// The UI renders these as a checklist the user approves.
router.get('/seo/market-monitor/suggestions', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const tier = (site.seo_addon_tier || '').toLowerCase();
    if (tier !== 'authority') {
      return res.json({ connected: true, authorityGated: true, tier, ownPageSuggestions: [], competitorSuggestions: [] });
    }

    const domain = (site.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const ownOrigin = `https://${domain}`;

    // ── Own-site suggestions: top pages from our gsc_page_performance table
    // if present, otherwise fall back to a simple homepage suggestion.
    let ownPageSuggestions = [];
    try {
      const ownRes = await pool.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .query(`
          SELECT TOP 15 page, SUM(clicks) AS clicks, SUM(impressions) AS impressions
          FROM arion.gsc_page_performance
          WHERE site_id = @siteId
            AND date_recorded >= DATEADD(DAY, -90, CAST(GETUTCDATE() AS DATE))
          GROUP BY page
          ORDER BY SUM(clicks) DESC
        `);
      ownPageSuggestions = ownRes.recordset
        .filter((r) => typeof r.page === 'string' && r.page.startsWith('http'))
        .map((r) => ({
          pageUrl: r.page,
          pageType: 'own_site',
          reason: `${r.clicks ?? 0} clicks · ${r.impressions ?? 0} impressions (last 90d)`,
          priority: Number(r.clicks || 0),
        }));
    } catch (e) {
      // gsc_page_performance may not exist on every deploy — fall back gracefully
      console.warn('[mm/suggestions] own-site GSC lookup failed:', e.message);
    }

    // Always include homepage as a baseline suggestion (user can uncheck)
    if (!ownPageSuggestions.some((s) => s.pageUrl === ownOrigin || s.pageUrl === `${ownOrigin}/`)) {
      ownPageSuggestions.unshift({
        pageUrl: `${ownOrigin}/`,
        pageType: 'own_site',
        reason: 'Homepage (baseline recommendation)',
        priority: Number.MAX_SAFE_INTEGER,
      });
    }

    // ── Competitor suggestions: list tracked competitors, then for each call
    // SE Ranking Data API for their top pages + add homepage + /blog/.
    let competitorSuggestions = [];
    if (site.se_ranking_project_id) {
      try {
        const projectId = site.se_ranking_project_id;
        const positionsRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions`);
        const engineBlocks = Array.isArray(positionsRaw.data) ? positionsRaw.data : [];
        const firstEngineId = engineBlocks[0]?.site_engine_id;
        const compsRaw = firstEngineId
          ? await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/competitors?se_id=${encodeURIComponent(firstEngineId)}`)
          : { ok: false };
        const competitors = compsRaw.ok && Array.isArray(compsRaw.data) ? compsRaw.data : [];

        for (const c of competitors) {
          const compDomain = String(c.url || c.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
          if (!compDomain) continue;
          const compOrigin = `https://${compDomain}`;

          // Start with homepage
          const perCompetitor = [{
            pageUrl: `${compOrigin}/`,
            pageType: 'competitor',
            competitorDomain: compDomain,
            reason: 'Competitor homepage (baseline)',
            priority: 100,
          }];

          // SE Ranking Data API — /domain/overview top-pages. Endpoint shape
          // varies per plan; we try the common path and gracefully no-op.
          try {
            const dataKey = process.env.SERANKING_DATA_API_KEY || process.env.SE_RANKING_DATA_API_KEY;
            if (dataKey) {
              const resp = await fetch(`https://api.seranking.com/v1/domain/overview?domain=${encodeURIComponent(compDomain)}`, {
                headers: { 'Authorization': `Token ${dataKey}` },
              });
              if (resp.ok) {
                const body = await resp.json().catch(() => null);
                const topPages = Array.isArray(body?.top_pages) ? body.top_pages
                               : Array.isArray(body?.pages) ? body.pages
                               : [];
                for (const tp of topPages.slice(0, 3)) {
                  const u = String(tp.url || tp.page || '').trim();
                  if (!u || !/^https?:/.test(u)) continue;
                  perCompetitor.push({
                    pageUrl: u,
                    pageType: 'competitor',
                    competitorDomain: compDomain,
                    reason: `Top traffic page${tp.traffic ? ` (~${tp.traffic} monthly visits)` : ''}`,
                    priority: 90 - perCompetitor.length,
                  });
                }
              }
            }
          } catch (e) {
            console.warn(`[mm/suggestions] Data API failed for ${compDomain}:`, e.message);
          }

          // Detect /blog/ or /resources/ by probing homepage HTML for links
          try {
            const homeResp = await fetch(compOrigin, {
              headers: { 'User-Agent': 'IADM-ARION-Suggestions/1.0' },
              signal: AbortSignal.timeout(8000),
            });
            if (homeResp.ok) {
              const html = await homeResp.text();
              const blogMatch = html.match(/href=["']([^"']*\/(?:blog|resources|insights|news)\/?)["']/i);
              if (blogMatch) {
                let blogHref = blogMatch[1];
                if (blogHref.startsWith('/')) blogHref = compOrigin + blogHref;
                if (!perCompetitor.some((p) => p.pageUrl === blogHref)) {
                  perCompetitor.push({
                    pageUrl: blogHref,
                    pageType: 'competitor',
                    competitorDomain: compDomain,
                    reason: 'Content hub (change = new content published)',
                    priority: 80,
                  });
                }
              }
            }
          } catch {
            // homepage probe timeout is fine, skip
          }

          competitorSuggestions = competitorSuggestions.concat(perCompetitor);
        }
      } catch (e) {
        console.warn('[mm/suggestions] competitor lookup failed:', e.message);
      }
    }

    // Propose default allocation across competitors (7-5-3-3-2 pattern) so the
    // UI can pre-check the right set of boxes.
    const byCompetitor = new Map();
    for (const s of competitorSuggestions) {
      if (!byCompetitor.has(s.competitorDomain)) byCompetitor.set(s.competitorDomain, []);
      byCompetitor.get(s.competitorDomain).push(s);
    }
    const ALLOCATION = [7, 5, 3, 3, 2]; // sums to 20
    let allocIdx = 0;
    const preChecked = new Set();
    for (const [, list] of byCompetitor) {
      const slots = ALLOCATION[allocIdx] ?? 2;
      allocIdx++;
      list.sort((a, b) => b.priority - a.priority);
      list.slice(0, slots).forEach((item) => preChecked.add(item.pageUrl));
    }

    res.json({
      connected: true,
      authorityGated: false,
      tier,
      limits: MM_LIMITS,
      ownPageSuggestions: ownPageSuggestions
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 15)
        .map((s) => ({ ...s, preChecked: true })),
      competitorSuggestions: competitorSuggestions.map((s) => ({
        ...s,
        preChecked: preChecked.has(s.pageUrl),
      })),
    });
  } catch (err) {
    console.error('[arion/seo/market-monitor/suggestions]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/competitors?siteId= ---
// Dedicated competitors feed — iterates every engine on the SE Ranking project
// and aggregates "My Competitors" (added) lists. De-duplicates by domain and
// surfaces visibility / overlap fields when present.
//
// Why this exists separately from the legacy /arion/seo breakdown: that path
// only returns competitors for ONE engine (the first one it sees in positions
// for the current date range). If positions for that range/engine are empty,
// firstEngineId comes back undefined and competitors drops to []. This endpoint
// walks all engines and merges, so it matches what SE Ranking's own UI shows.
router.get('/seo/competitors', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.json({ connected: false, competitors: [] });

    const projectId = site.se_ranking_project_id;

    // Correct SE Ranking Project API path (confirmed via docs + browser probe
    // 2026-04-19): /competitors/site/{site_id} returns the full tracked
    // competitor list for the project, engine-independent. The previously
    // used /sites/{id}/competitors?se_id=X pattern does not exist in the
    // current v4 API — it returns 400 on all shapes.
    const upstreamErrors = [];
    const byDomain = new Map();

    const listRaw = await seRankingRaw('GET', `/competitors/site/${encodeURIComponent(projectId)}`);
    if (!listRaw.ok) {
      upstreamErrors.push({ endpoint: `/competitors/site/${projectId}`, status: listRaw.status, errorText: listRaw.errorText || null });
    } else if (Array.isArray(listRaw.data)) {
      for (const c of listRaw.data) {
        const url = String(c.url || c.name || '').trim();
        const domainKey = url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (!domainKey) continue;
        // SE Ranking's /competitors/site/{id} returns DT, visibility, and
        // keyword-count signals. Field names vary across API versions — try
        // the most likely keys and fall back to null.
        const visibilityScore = c.visibility_score ?? c.visibility ?? c.visib ?? null;
        const keywordsCount = c.keywords_count ?? c.keywords ?? c.kw_count ?? c.total_keywords ?? null;
        const trafficSum = c.traffic_sum ?? c.traffic ?? c.organic_traffic ?? null;
        byDomain.set(domainKey, {
          id: c.id ?? null,
          domain: domainKey,
          competitor: url || domainKey,
          url: url || null,
          engines: [],
          visibility: typeof visibilityScore === 'number' ? visibilityScore : null,
          visibility_score: typeof visibilityScore === 'number' ? visibilityScore : null,
          keywords: typeof keywordsCount === 'number' ? keywordsCount : null,
          traffic: typeof trafficSum === 'number' ? trafficSum : null,
          overlap: c.overlap ?? null,
          domainTrust: typeof c.domain_trust === 'number' ? c.domain_trust : null,
          added_at: c.added_at ?? c.created_at ?? null,
          raw: c,
        });
      }
    }

    const competitors = Array.from(byDomain.values());

    // Content Gap: keywords where at least one tracked competitor ranks in
    // top 10 and we do not. Sourced from /sites/{id}/positions which returns
    // OUR positions per keyword; for competitor positions we fetch the
    // competitor-scoped endpoint.
    // Best-effort: single most-recent snapshot, fail-soft on any upstream error.
    let contentGap = [];
    try {
      const today = new Date();
      const fromDate = new Date(today.getTime() - 7 * 86400000).toISOString().split('T')[0];
      const toDate = today.toISOString().split('T')[0];
      const posRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions?date_from=${fromDate}&date_to=${toDate}`);
      const ourKeywordPositions = new Map(); // keywordId -> { keyword, searchVolume, ourBestPos }

      if (posRaw.ok && Array.isArray(posRaw.data)) {
        for (const engineBlock of posRaw.data) {
          for (const kw of engineBlock.keywords || []) {
            const kwId = String(kw.keyword_id || kw.id || '');
            if (!kwId) continue;
            const latestPos = (kw.positions || [])
              .map((p) => Number(p.pos || 0))
              .filter((n) => n > 0)
              .sort((a, b) => a - b)[0] ?? null;
            const existing = ourKeywordPositions.get(kwId);
            if (!existing || (latestPos != null && (existing.ourBestPos == null || latestPos < existing.ourBestPos))) {
              ourKeywordPositions.set(kwId, {
                keyword: kw.keyword || existing?.keyword || '',
                searchVolume: kw.search_volume ?? kw.sv ?? existing?.searchVolume ?? null,
                ourBestPos: latestPos ?? existing?.ourBestPos ?? null,
              });
            }
          }
        }
      }

      // Per-competitor fetch: /sites/{id}/competitors/{competitorId}/positions
      // (some SE Ranking versions use this path). Falls back silently.
      const gapByKeyword = new Map();
      const compFetches = competitors.slice(0, 10).map(async (comp) => {
        if (!comp.id) return;
        const compPosRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/competitors/${encodeURIComponent(comp.id)}/positions?date_from=${fromDate}&date_to=${toDate}`)
          .catch(() => ({ ok: false }));
        if (!compPosRaw.ok || !Array.isArray(compPosRaw.data)) return;
        for (const engineBlock of compPosRaw.data) {
          for (const kw of engineBlock.keywords || []) {
            const kwId = String(kw.keyword_id || kw.id || '');
            const latestPos = (kw.positions || [])
              .map((p) => Number(p.pos || 0))
              .filter((n) => n > 0)
              .sort((a, b) => a - b)[0] ?? null;
            if (!kwId || latestPos == null || latestPos > 10) continue;
            const us = ourKeywordPositions.get(kwId);
            const ourPos = us?.ourBestPos ?? null;
            // Content gap = competitor top-10, us not top-10 (or not ranking)
            if (ourPos != null && ourPos <= 10) continue;
            const row = gapByKeyword.get(kwId) || {
              keywordId: kwId,
              keyword: kw.keyword || us?.keyword || '',
              searchVolume: kw.search_volume ?? us?.searchVolume ?? null,
              ourPosition: ourPos,
              competitorPositions: [],
            };
            if (!row.competitorPositions.find((r) => r.domain === comp.domain)) {
              row.competitorPositions.push({ domain: comp.domain, position: latestPos });
            }
            gapByKeyword.set(kwId, row);
          }
        }
      });
      await Promise.all(compFetches);

      contentGap = Array.from(gapByKeyword.values())
        .map((g) => ({ ...g, competitorPositions: g.competitorPositions.sort((a, b) => a.position - b.position) }))
        .sort((a, b) => {
          const aMin = a.competitorPositions[0]?.position ?? 99;
          const bMin = b.competitorPositions[0]?.position ?? 99;
          return aMin - bMin;
        })
        .slice(0, 100);
    } catch (e) {
      console.warn('[arion/seo/competitors] content gap fetch failed:', e.message);
    }

    res.json({
      connected: true,
      projectId,
      competitors,
      contentGap,
      upstreamErrors: upstreamErrors.length ? upstreamErrors : undefined,
    });
  } catch (err) {
    console.error('[arion/seo/competitors]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/ai-search?siteId=&range=30d ---
// AI Search (AIRT) — aggregates across all LLM engines tracked for the
// project. Returns per-engine stats + recent prompt rankings + source pages
// + competitor mentions.
router.get('/seo/ai-search', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const rangeCode = (req.query.range || '30d').toString().toLowerCase();
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });

  const AI_ENGINE_META = (baseName) => {
    const n = String(baseName || '').toLowerCase();
    if (n === 'chatgpt') return { label: 'ChatGPT', tierRequired: 'growth' };
    if (n === 'gemini') return { label: 'Gemini', tierRequired: 'growth' };
    if (n === 'ai_mode' || n === 'aimode') return { label: 'Google AI Mode', tierRequired: 'growth' };
    if (n === 'ai_overview' || n === 'aioverview') return { label: 'Google AI Overview', tierRequired: 'authority' };
    if (n === 'perplexity') return { label: 'Perplexity', tierRequired: 'consulting' };
    return { label: baseName || 'AI Engine', tierRequired: 'authority' };
  };

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.json({ connected: false, engines: [], aggregate: null });

    const tier = (site.seo_addon_tier || '').toLowerCase();
    const tierRank = { starter: 0, essentials: 1, growth: 2, authority: 3 }[tier] ?? 0;
    if (tierRank < 2) {
      return res.json({
        connected: true,
        tierGated: true,
        tier,
        message: 'AI Search Results require the Growth or Authority SEO tier.',
        engines: [],
        aggregate: { totalMentions: 0, uniquePromptsMentioned: 0, totalPromptsTracked: 0, visibilityScore: 0, topSourcePages: [], competitorMentions: [] },
      });
    }

    const projectId = site.se_ranking_project_id;

    // Resolve date range
    const range = resolveRange(rangeCode);
    const from = range.current.start;
    const to = range.current.end;
    const priorFrom = range.prior.start;
    const priorTo = range.prior.end;

    // 1) List engines for this project
    const llmRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/airt/llm`).catch((e) => ({ ok: false, errorText: e.message }));
    const llms = llmRaw.ok && Array.isArray(llmRaw.data) ? llmRaw.data : [];

    // 2) Per engine: statistics (current + prior) and latest prompts ranking
    const engines = [];
    const sourceByUrl = new Map();       // url -> { url, citationCount, engines:Set }
    const competitorByName = new Map();  // name -> { competitor, count, engines:Set }
    let totalMentions = 0;
    let totalPromptsTracked = 0;
    const uniquePromptIdsMentioned = new Set();
    let visibilitySum = 0;
    let visibilityEngineCount = 0;

    await Promise.all(llms.map(async (llm) => {
      const baseName = String(llm.base_name || '').toLowerCase();
      const meta = AI_ENGINE_META(baseName);
      // tier unlock: growth unlocks chatgpt/gemini/ai_mode; authority adds ai_overview
      const minRank = meta.tierRequired === 'growth' ? 2 : meta.tierRequired === 'authority' ? 3 : 99;
      const unlocked = tierRank >= minRank;

      const engineId = String(llm.id);
      const engineEntry = {
        engineId,
        baseName,
        label: meta.label,
        region: llm.region_name || null,
        lang: llm.lang_code ? String(llm.lang_code).toUpperCase() : null,
        unlocked,
        tierRequired: meta.tierRequired,
        current: { mentions: 0, avgPosition: null, visibilityScore: 0, promptsCount: 0, linkedCount: 0 },
        prior: { mentions: 0, avgPosition: null, visibilityScore: 0, promptsCount: 0, linkedCount: 0 },
        delta: { mentions: 0, visibilityScore: 0, avgPosition: null },
        recentPrompts: [],
        upstreamErrors: [],
      };

      if (!unlocked) {
        engines.push(engineEntry);
        return;
      }

      // Statistics (current period + prior period)
      const [statRaw, priorStatRaw] = await Promise.all([
        seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/airt/llm/${encodeURIComponent(engineId)}/statistics?date_from=${from}&date_to=${to}`).catch(() => ({ ok: false })),
        seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/airt/llm/${encodeURIComponent(engineId)}/statistics?date_from=${priorFrom}&date_to=${priorTo}`).catch(() => ({ ok: false })),
      ]);

      const readStats = (raw) => {
        if (!raw.ok || !raw.data) return { mentions: 0, avgPosition: null, visibilityScore: 0, promptsCount: 0, linkedCount: 0 };
        const d = raw.data;
        return {
          mentions: Number(d.mentions_count ?? d.mentioned_count ?? d.mentions ?? 0),
          avgPosition: d.avg_position != null ? Number(d.avg_position) : d.average_position != null ? Number(d.average_position) : null,
          visibilityScore: Number(d.visibility_score ?? d.visibility ?? 0),
          promptsCount: Number(d.prompts_count ?? d.total_prompts ?? 0),
          linkedCount: Number(d.linked_count ?? d.link_mentions ?? d.with_link ?? 0),
        };
      };

      engineEntry.current = readStats(statRaw);
      engineEntry.prior = readStats(priorStatRaw);
      engineEntry.delta = {
        mentions: engineEntry.current.mentions - engineEntry.prior.mentions,
        visibilityScore: Math.round((engineEntry.current.visibilityScore - engineEntry.prior.visibilityScore) * 10) / 10,
        avgPosition: engineEntry.current.avgPosition != null && engineEntry.prior.avgPosition != null
          ? Math.round((engineEntry.prior.avgPosition - engineEntry.current.avgPosition) * 10) / 10
          : null,
      };

      totalMentions += engineEntry.current.mentions;
      if (engineEntry.current.promptsCount > totalPromptsTracked) totalPromptsTracked = engineEntry.current.promptsCount;
      if (engineEntry.current.visibilityScore > 0) {
        visibilitySum += engineEntry.current.visibilityScore;
        visibilityEngineCount++;
      }

      // Prompts: try the most recent date in range first; fall back to range end
      const promptsDate = to;
      const promptsRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/airt/llm/${encodeURIComponent(engineId)}/prompts/rankings?date=${promptsDate}`).catch(() => ({ ok: false }));
      if (promptsRaw.ok && Array.isArray(promptsRaw.data)) {
        for (const p of promptsRaw.data) {
          const promptId = String(p.prompt_id || p.id || '');
          const mentioned = !!(p.mentioned || p.is_mentioned || (p.position != null && Number(p.position) > 0));
          const citationUrls = Array.isArray(p.links) ? p.links.map((l) => String(l.url || l)).filter(Boolean)
                              : Array.isArray(p.citations) ? p.citations.map((c) => String(c.url || c)).filter(Boolean)
                              : [];
          const competitors = Array.isArray(p.competitors) ? p.competitors : Array.isArray(p.mentions) ? p.mentions : [];
          engineEntry.recentPrompts.push({
            promptId,
            prompt: p.prompt || p.query || '',
            position: p.position ?? null,
            mentioned,
            citationUrls,
            competitors: competitors.map((c) => String(c.name || c.domain || c)).filter(Boolean),
            date: p.date || promptsDate,
          });
          if (mentioned && promptId) uniquePromptIdsMentioned.add(`${engineId}:${promptId}`);
          for (const url of citationUrls) {
            const k = url.toLowerCase().replace(/\/$/, '');
            const ex = sourceByUrl.get(k) || { url, citationCount: 0, engines: new Set() };
            ex.citationCount++;
            ex.engines.add(meta.label);
            sourceByUrl.set(k, ex);
          }
          for (const comp of (p.competitors || [])) {
            const name = String(comp.name || comp.domain || comp || '').trim();
            if (!name) continue;
            const ex = competitorByName.get(name) || { competitor: name, count: 0, engines: new Set() };
            ex.count++;
            ex.engines.add(meta.label);
            competitorByName.set(name, ex);
          }
        }
      } else if (!promptsRaw.ok) {
        engineEntry.upstreamErrors.push(`prompts/rankings: HTTP ${promptsRaw.status || 'n/a'}`);
      }
      engineEntry.recentPrompts.sort((a, b) => (b.mentioned ? 1 : 0) - (a.mentioned ? 1 : 0));

      engines.push(engineEntry);
    }));

    const topSourcePages = Array.from(sourceByUrl.values())
      .map((s) => ({ url: s.url, citationCount: s.citationCount, engines: Array.from(s.engines) }))
      .sort((a, b) => b.citationCount - a.citationCount)
      .slice(0, 25);

    const competitorMentions = Array.from(competitorByName.values())
      .map((c) => ({ competitor: c.competitor, count: c.count, engines: Array.from(c.engines) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    res.json({
      connected: true,
      tier,
      tierGated: false,
      range: { code: rangeCode, current: range.current, prior: range.prior, days: range.days },
      engines,
      aggregate: {
        totalMentions,
        uniquePromptsMentioned: uniquePromptIdsMentioned.size,
        totalPromptsTracked,
        visibilityScore: visibilityEngineCount > 0 ? Math.round((visibilitySum / visibilityEngineCount) * 10) / 10 : 0,
        topSourcePages,
        competitorMentions,
      },
    });
  } catch (err) {
    console.error('[arion/seo/ai-search]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/seo/competitors/add ---
// Body: { siteId, domain }
router.post('/seo/competitors/add', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId, domain } = req.body || {};
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  const cleanDomain = typeof domain === 'string' ? domain.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
  if (!cleanDomain) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.status(400).json({ error: { code: 'NOT_CONNECTED', message: 'SE Ranking project not configured for this site', status: 400 } });

    // SE Ranking competitors require se_id (search engine) scoping. Pull the
    // first engine from the project's positions to discover a valid se_id.
    const positionsRaw = await seRankingRaw('GET', `/sites/${encodeURIComponent(site.se_ranking_project_id)}/positions`);
    const seId = Array.isArray(positionsRaw.data) && positionsRaw.data[0]?.site_engine_id;
    if (!seId) return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: 'Could not resolve a search engine id for this project', status: 502 } });

    const addRaw = await seRankingRaw('POST', `/sites/${encodeURIComponent(site.se_ranking_project_id)}/competitors?se_id=${encodeURIComponent(seId)}`, { url: cleanDomain });
    if (!addRaw.ok) {
      return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: `SE Ranking rejected: HTTP ${addRaw.status} ${addRaw.errorText || ''}`, status: 502 } });
    }
    const result = addRaw.data || {};

    res.json({
      ok: true,
      competitor: {
        id: result.id ?? null,
        domain: result.domain || cleanDomain,
        visibility: result.visibility ?? null,
      },
    });
  } catch (err) {
    console.error('[arion/seo/competitors/add]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/diagnostic?siteId= ---
// Hits every SE Ranking Project API surface we use and returns raw upstream
// status + payload shape so we can see exactly what's failing when the UI
// shows "no data". Exposes env-key presence, upstream HTTP codes, response
// shapes, and error bodies.
router.get('/seo/diagnostic', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const projectId = site.se_ranking_project_id;
    const auditId = site.se_ranking_audit_id || null;

    const projectKeyNames = ['SERANKING_API_SYSTEM_KEY', 'SE-RANKING-API-KEY', 'SE_RANKING_API_KEY'];
    const dataKeyNames = ['SERANKING_DATA_API_KEY', 'SE-RANKING-DATA-API-KEY', 'SE_RANKING_DATA_API_KEY'];
    const envKeyPresent = projectKeyNames.some(n => String(process.env[n] || '').trim());
    const dataKeyPresent = dataKeyNames.some(n => String(process.env[n] || '').trim());
    const projectKeyFoundAs = projectKeyNames.find(n => String(process.env[n] || '').trim()) || null;
    const dataKeyFoundAs = dataKeyNames.find(n => String(process.env[n] || '').trim()) || null;

    const summarize = (label, r) => ({
      label,
      url: r.url,
      keyConfigured: r.keyConfigured,
      ok: r.ok,
      httpStatus: r.status,
      errorText: r.errorText,
      dataType: Array.isArray(r.data) ? 'array' : (r.data === null ? 'null' : typeof r.data),
      count: Array.isArray(r.data) ? r.data.length : undefined,
      sample: Array.isArray(r.data) ? r.data.slice(0, 2) : r.data,
    });

    // Call each endpoint. Even if projectId is missing we still surface the
    // /sites call so the user can see whether the API key works at all.
    const results = {};
    results.listProjects = summarize('GET /sites', await seRankingRaw('GET', '/sites'));

    if (projectId) {
      results.project = summarize(`GET /sites/${projectId}`, await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}`));
      results.keywords = summarize(`GET /sites/${projectId}/keywords`, await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/keywords`));
      results.positions = summarize(`GET /sites/${projectId}/positions`, await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/positions`));

      // Engine metadata probes — SE Ranking docs vary on the exact path.
      // /system/search-engines is confirmed 200 with 4263 rows (global catalog).
      // What we still need is the site_engine_id → base engine + device + city
      // mapping. Site-engine ids (46877, etc) are per-project instances.
      const engineProbes = [
        '/system/search-engines',
        '/system/engines',
        '/engines',
        `/sites/${encodeURIComponent(projectId)}/site-engines`,
        `/sites/${encodeURIComponent(projectId)}/engines`,
      ];
      for (const p of engineProbes) {
        results[`engines_${p.replace(/[^a-z0-9]/gi, '_')}`] = summarize(`GET ${p}`, await seRankingRaw('GET', p));
      }

      // Per-site-engine probes: try to resolve one of the actual ids the
      // project uses (picked from /positions). Multiple URL shapes — one
      // of them is probably the right lookup.
      const firstSiteEngineId = results.positions.sample?.[0]?.site_engine_id;
      if (firstSiteEngineId != null) {
        const siteEngineProbes = [
          `/site-engines/${firstSiteEngineId}`,
          `/sites/${encodeURIComponent(projectId)}/se/${firstSiteEngineId}`,
          `/sites/${encodeURIComponent(projectId)}/site-engines/${firstSiteEngineId}`,
          `/sites/${encodeURIComponent(projectId)}/engines/${firstSiteEngineId}`,
          `/system/search-engines/${firstSiteEngineId}`,
        ];
        for (const p of siteEngineProbes) {
          results[`site_engine_${p.replace(/[^a-z0-9]/gi, '_')}`] = summarize(`GET ${p}`, await seRankingRaw('GET', p));
        }
      }

      // Competitors with se_id derived from first positions engine.
      const firstEngineId = results.positions.sample?.[0]?.site_engine_id;
      if (firstEngineId != null) {
        results.competitorsWithEngine = summarize(`GET /sites/${projectId}/competitors?se_id=${firstEngineId}`, await seRankingRaw('GET', `/sites/${encodeURIComponent(projectId)}/competitors?se_id=${encodeURIComponent(firstEngineId)}`));
      }

      // Site-audit endpoint probes. The docs are ambiguous on which path
      // is current — try several to find what actually returns a real audit.
      const auditProbes = [
        `/audit/sites/${projectId}`,
        `/audit/${projectId}`,
        `/sites/${projectId}/audit`,
        `/audit/reports?site_id=${projectId}`,
        `/site-audit/reports?site_id=${projectId}`,
        '/site-audit/audits',
      ];
      for (const p of auditProbes) {
        results[`audit_probe_${p.replace(/[^a-z0-9]/gi, '_')}`] = summarize(`GET ${p}`, await seRankingRaw('GET', p));
      }
    }

    // Probe for the audit-issues detail endpoint so Phase 3.5 Site Audit can
    // populate the "issues by category" table. /audit/{projectId} returns
    // only the top-level counts; detail probably lives at a sub-path.
    if (projectId) {
      const auditIssueProbes = [
        `/audit/${encodeURIComponent(projectId)}/issues`,
        `/audit/${encodeURIComponent(projectId)}/report`,
        `/audit/${encodeURIComponent(projectId)}/sections`,
        `/audit/${encodeURIComponent(projectId)}/categories`,
        `/audit/${encodeURIComponent(projectId)}/pages`,
        `/audit/${encodeURIComponent(projectId)}/urls`,
        `/audit/${encodeURIComponent(projectId)}/resources`,
        `/audit/${encodeURIComponent(projectId)}/links`,
      ];
      for (const p of auditIssueProbes) {
        results[`audit_issues_${p.replace(/[^a-z0-9]/gi, '_')}`] = summarize(`GET ${p}`, await seRankingRaw('GET', p));
      }
    }

    if (auditId) {
      results.audit = summarize(`GET /site-audit/audits/${auditId}`, await seRankingRaw('GET', `/site-audit/audits/${encodeURIComponent(auditId)}`));
    }

    res.json({
      site: {
        siteId: site.site_id,
        domain: site.domain,
        seRankingProjectId: projectId,
        seRankingAuditId: auditId,
        seoAddonTier: site.seo_addon_tier,
      },
      env: {
        SERANKING_API_SYSTEM_KEY: envKeyPresent ? `set (as ${projectKeyFoundAs})` : 'MISSING',
        SERANKING_DATA_API_KEY: dataKeyPresent ? `set (as ${dataKeyFoundAs})` : 'MISSING',
        base: process.env.SERANKING_API_BASE || 'https://api4.seranking.com',
      },
      results,
    });
  } catch (err) {
    console.error('[arion/seo/diagnostic]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/seo/decay?siteId= ---
// Content decay detection: pages that dropped 3+ positions vs ~30 days ago.
router.get('/seo/decay', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.se_ranking_project_id) return res.json({ connected: false, decaying: [] });

    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const [current, prior, keywordMeta] = await Promise.all([
      getPositionsHistory(site.se_ranking_project_id, fmt(monthAgo), fmt(today), tenantId).catch(() => []),
      getPositionsHistory(site.se_ranking_project_id, fmt(new Date(monthAgo.getTime() - 30 * 24 * 3600 * 1000)), fmt(monthAgo), tenantId).catch(() => []),
      getProjectKeywords(site.se_ranking_project_id, tenantId).catch(() => []),
    ]);
    const metaById = {};
    for (const m of keywordMeta || []) {
      const id = m.id ?? m.keyword_id;
      if (id != null) metaById[String(id)] = { keyword: m.name || m.keyword || '', volume: Number(m.volume ?? 0) };
    }

    // Group by keyword_id, take the best (lowest) position per period.
    const bestByPeriod = (rows) => {
      const m = {};
      for (const r of rows || []) {
        const id = String(r.keyword_id ?? r.id ?? '');
        if (!id) continue;
        const pos = Number(r.pos ?? r.position ?? 0);
        if (!pos) continue;
        if (m[id] == null || pos < m[id].pos) m[id] = { pos, url: r.url || r.landing_url || null };
      }
      return m;
    };
    const curMap = bestByPeriod(current);
    const priorMap = bestByPeriod(prior);

    const decaying = [];
    for (const [id, cur] of Object.entries(curMap)) {
      const p = priorMap[id];
      if (!p) continue;
      const delta = cur.pos - p.pos; // positive delta = rank got worse (further from #1)
      if (delta >= 3) {
        const meta = metaById[id] || {};
        decaying.push({
          keywordId: Number(id),
          keyword: meta.keyword || '',
          url: cur.url || null,
          priorPosition: p.pos,
          currentPosition: cur.pos,
          change: delta,
          searchVolume: meta.volume || 0,
        });
      }
    }
    decaying.sort((a, b) => b.change - a.change);

    res.json({ connected: true, decaying });
  } catch (err) {
    console.error('[arion/seo/decay]', err);
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

    // Step 4: write the CNAME via Hostinger DNS API. Use overwrite=true so a re-click
    // after a previous successful write is idempotent — Hostinger would otherwise
    // reject with 4008 (record already exists).
    const dnsResult = await createDnsRecords(site.domain, [{ type: 'CNAME', name: subdomain, content: 'verify.bing.com.', ttl: 300 }], true);
    if (!dnsResult.ok) {
      return res.json({
        connected: false,
        stage: 'dns_write',
        error: dnsResult.error || 'Hostinger DNS write failed',
        hostingerStatus: dnsResult.status || null,
        dnsRecordNeeded: { type: 'CNAME', name: subdomain, content: 'verify.bing.com.' },
      });
    }

    // Return immediately — we've written the DNS record and Bing will verify
    // async. Client polls /arion/bing/check-verification to detect completion.
    // This avoids the portal's 20s request timeout while Bing takes 30s-5min
    // to propagate DNS and run its verification check.
    res.json({
      connected: false,
      pending: true,
      stage: 'dns_written',
      siteUrl,
      dnsRecord: { type: 'CNAME', name: subdomain, content: 'verify.bing.com.' },
      message: 'DNS verification record written. Bing is checking now — this usually takes 30-90 seconds.',
    });
  } catch (err) {
    console.error('[arion/bing/auto-connect]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/bing/check-verification?siteId= ---
// Single-shot "is Bing done verifying yet?" check. Designed for client-side
// polling. Returns quickly so portal fetches don't time out.
router.post('/bing/check-verification', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId || req.body?.siteId;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  const masterKey = process.env.BING_WMT_API_KEY;
  if (!masterKey) return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Bing master API key not configured', status: 503 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const siteUrl = 'https://' + site.domain + '/';
    const entry = await bingGetSiteEntry(masterKey, siteUrl);
    if (!entry) return res.json({ connected: false, pending: true, found: false });
    if (!entry.IsVerified) return res.json({ connected: false, pending: true, found: true });
    // Verified — persist and flip the DB flag
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('siteUrl', sql.NVarChar(300), entry.Url || siteUrl)
      .input('now', sql.DateTime2, new Date())
      .query(`UPDATE arion.site
              SET bing_api_key = NULL, bing_site_url = @siteUrl, bing_connected = 1, bing_connected_at = @now
              WHERE tenant_id = @tenantId AND site_id = @siteId`);
    res.json({ connected: true, siteUrl: entry.Url || siteUrl });
  } catch (err) {
    console.error('[arion/bing/check-verification]', err);
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
// Gates on arion.site.bing_connected — the DB flag flipped by /bing/auto-connect
// when Bing finishes verifying ownership. This keeps the Settings "Not connected"
// state and IA Insights observations in sync: IA Insights will say "Connect Bing"
// until the user connects AND Bing verifies, and will light up automatically the
// next time IAInsightsReports re-fetches after bing_connected=1 is persisted.
router.get('/bing/performance', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.query.siteId;
  const period = [30, 90, 365].includes(parseInt(req.query.period, 10)) ? parseInt(req.query.period, 10) : 30;
  if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.bing_connected) return res.json({ connected: false, period, summary: null, dailyBreakdown: [] });
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
    if (!site.bing_connected) return res.json({ connected: false, queries: [] });
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
// v2.0.13 — SECURITY: Removed unsafe auto-resolution that picked the
// first location from accounts[0].locations[0]. If no location has been
// explicitly selected for this site, return 'gbp_location_not_selected'
// so the Portal renders the location-picker instead of pulling random data.
async function getGbpContext(pool, tenantId, siteId) {
  const site = await getSiteForTenant(pool, tenantId, siteId);
  if (!site) return { error: 'site_not_found', status: 404 };
  if (!site.gbp_connected) return { error: 'not_connected', site };
  const refreshToken = site.gbp_oauth_token_ref;
  if (!refreshToken) return { error: 'not_connected', site };
  const locationName = site.gbp_location_name || null;
  if (!locationName) return { error: 'gbp_location_not_selected', site };
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
  const { records, overwrite } = req.body;
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

    const result = await createDnsRecords(site.domain, records, !!overwrite);
    if (!result.ok) {
      return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: result.error || 'Failed to create DNS records', status: 502, hostingerStatus: result.status || null, hostingerBody: result.body || null } });
    }
    res.json({ domain: site.domain, result: result.data });
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
    if (!result.ok) {
      return res.status(502).json({ error: { code: 'UPSTREAM_ERROR', message: result.error || 'Failed to delete DNS records', status: 502, hostingerStatus: result.status || null, hostingerBody: result.body || null } });
    }
    res.json({ domain: site.domain, result: result.data });
  } catch (err) {
    console.error('[arion/hosting/dns DELETE]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- POST /arion/hosting/pagespeed?siteId= — Run PageSpeed test + persist ---
// Fire-and-forget: responds immediately with { queued: true, strategies: [...] }
// so the Portal doesn't hit its 20s HTTP timeout (PSI takes 30-45s per strategy).
// The runs complete in the background and save to site_pagespeed_snapshot.
// Portal polls /pagespeed-history to detect when new rows land.
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
    const triggeredBy = req.body?.triggered_by || 'manual';

    // Determine which strategies to run. Default = BOTH so a single click
    // gives the user mobile + desktop as they requested.
    const strategies = strategy && (strategy === 'mobile' || strategy === 'desktop')
      ? [strategy]
      : ['mobile', 'desktop'];

    // Respond immediately so the Portal doesn't time out
    res.json({ queued: true, strategies, testUrl, estimated_wait_seconds: strategies.length * 45 });

    // Run in background (after response sent). Azure Functions keeps the
    // process alive long enough to complete. For safety, we serialize mobile
    // then desktop so we don't hit PSI rate limits.
    (async () => {
      for (const s of strategies) {
        try {
          const result = await runPageSpeedTest(testUrl, s);
          if (result) await savePageSpeedSnapshot(pool, tenantId, siteId, result, triggeredBy);
          console.log(`[psi:${s}] ${site.domain} saved: perf=${result?.scores?.performance ?? 'null'}`);
        } catch (err) {
          console.error(`[psi:${s}] ${site.domain} failed:`, err.message);
        }
      }
    })().catch((err) => console.error('[psi-background]', err));
  } catch (err) {
    console.error('[arion/hosting/pagespeed POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// Auto-trigger on site provisioning — called from provision flow
export async function triggerOnboardingPageSpeed(pool, tenantId, siteId, domain) {
  if (!domain) return { queued: false, reason: 'no_domain' };
  const testUrl = 'https://' + String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  (async () => {
    for (const s of ['mobile', 'desktop']) {
      try {
        const result = await runPageSpeedTest(testUrl, s);
        if (result) await savePageSpeedSnapshot(pool, tenantId, siteId, result, 'onboarding');
        console.log(`[psi:onboarding:${s}] ${domain} saved`);
      } catch (err) {
        console.error(`[psi:onboarding:${s}] ${domain} failed:`, err.message);
      }
    }
  })().catch((err) => console.error('[psi-onboarding]', err));
  return { queued: true, strategies: ['mobile', 'desktop'] };
}

// Upsert a PSI snapshot by (tenant_id, site_id, run_date, strategy).
async function savePageSpeedSnapshot(pool, tenantId, siteId, result, triggeredBy = 'manual') {
  if (!result) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const m = result.metrics || {};
  try {
    // Delete any existing snapshot for today+strategy so we store the latest
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('runDate', sql.Date, today)
      .input('strategy', sql.NVarChar(10), result.strategy || 'desktop')
      .query(`DELETE FROM arion.site_pagespeed_snapshot
              WHERE tenant_id=@tenantId AND site_id=@siteId AND run_date=@runDate AND strategy=@strategy`);

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('runDate', sql.Date, today)
      .input('strategy', sql.NVarChar(10), result.strategy || 'desktop')
      .input('performanceScore', sql.Int, result.scores?.performance ?? null)
      .input('accessibilityScore', sql.Int, result.scores?.accessibility ?? null)
      .input('seoScore', sql.Int, result.scores?.seo ?? null)
      .input('bestPracticesScore', sql.Int, result.scores?.bestPractices ?? null)
      .input('mobilePerformance', sql.Int, result.strategy === 'mobile' ? (result.scores?.performance ?? null) : null)
      .input('desktopPerformance', sql.Int, result.strategy === 'desktop' ? (result.scores?.performance ?? null) : null)
      .input('lcpMs', sql.Int, Math.round(m.lcp?.value ?? 0) || null)
      .input('inpMs', sql.Int, Math.round(m.inp?.value ?? 0) || null)
      .input('clsScore', sql.Decimal(6, 4), m.cls?.value != null ? Number(m.cls.value).toFixed(4) : null)
      .input('fcpMs', sql.Int, Math.round(m.fcp?.value ?? 0) || null)
      .input('tbtMs', sql.Int, Math.round(m.tbt?.value ?? 0) || null)
      .input('opportunities', sql.NVarChar(sql.MAX), JSON.stringify(result.opportunities || []))
      .input('cruxUrl', sql.NVarChar(sql.MAX), result.field_url ? JSON.stringify(result.field_url) : null)
      .input('cruxOrigin', sql.NVarChar(sql.MAX), result.field_origin ? JSON.stringify(result.field_origin) : null)
      .input('triggeredBy', sql.NVarChar(50), triggeredBy)
      .query(`
        INSERT INTO arion.site_pagespeed_snapshot
          (tenant_id, site_id, run_date, strategy,
           performance_score, accessibility_score, seo_score, best_practices_score,
           mobile_performance, desktop_performance,
           lcp_ms, inp_ms, cls_score, fcp_ms, tbt_ms,
           opportunities, crux_url_json, crux_origin_json, triggered_by)
        VALUES (@tenantId, @siteId, @runDate, @strategy,
                @performanceScore, @accessibilityScore, @seoScore, @bestPracticesScore,
                @mobilePerformance, @desktopPerformance,
                @lcpMs, @inpMs, @clsScore, @fcpMs, @tbtMs,
                @opportunities, @cruxUrl, @cruxOrigin, @triggeredBy)
      `);
  } catch (err) {
    console.error('[savePageSpeedSnapshot]', err.message);
  }
}

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
// v2.0.11 — Pivoted away from the broken Wordfence public feed
// (www.wordfence.com/api/intelligence/v2/vulnerabilities/production/ now
// returns HTTP 410 Gone — they retired unauthenticated access).
//
// New data sources:
//   1. Wordfence scan findings from the installed plugin — these are real
//      CVE matches found on the site by Wordfence's own scanner, which
//      keeps its DB updated automatically via the plugin.
//   2. Outdated active plugins — proxy for patch urgency, always available.
//
// This removes all external API dependencies — the data comes from
// Wordfence running locally on the site.

function semverLTE(a, b) {
  // Returns true if version a <= version b (naive). "a.b.c" compared left-to-right.
  if (!a || !b) return false;
  const pa = String(a).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return true; // equal counts as <=
}

// _deprecated — was used for matching against the retired Wordfence public feed.
// Kept for semver helper reuse; new vulnerability source is the local Wordfence
// scan-issues endpoint which already does the matching.
function _deprecated_matchVulnerability(vuln, installedVersion) {
  const software = Array.isArray(vuln.software) ? vuln.software : [];
  for (const s of software) {
    const affected = s.affected_versions || {};
    for (const range of Object.keys(affected)) {
      const leq = range.match(/^<=\s*([\d.\w-]+)$/);
      if (leq && semverLTE(installedVersion, leq[1])) return true;
    }
  }
  return false;
}

router.get('/sites/:siteId/vulnerabilities', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    // Pull plugin inventory via IA Plugin (site_token auth)
    let plugins = [];
    let pluginErr = null;
    const pluginInv = await pluginApi.plugins(site);
    if (pluginInv.ok && Array.isArray(pluginInv.data)) {
      plugins = pluginInv.data.map((p) => ({
        slug: p.slug || (p.file || '').split('/')[0] || p.name,
        name: p.name,
        version: p.version || '',
        file: p.file,
        active: !!p.active,
        update_available: !!p.update_available,
        new_version: p.new_version || null,
      }));
    } else {
      pluginErr = pluginInv.errorText || `plugin_status=${pluginInv.pluginStatus}`;
    }

    // v2.0.11 — Pull Wordfence scan findings from the installed plugin.
    // Wordfence keeps its vulnerability DB updated locally and flags
    // known-vuln plugins during its scans. Those findings come through
    // /security/scan-issues with type indicating vulnerable-plugin.
    const scanRes = await pluginApi.securityScanIssues(site);
    const scanIssues = (scanRes?.data?.issues || []);
    const wfInstalled = scanRes?.data?.installed !== false;

    // Build CVE-style vulnerability list from Wordfence scan findings that
    // reference plugins. Wordfence categorizes these with type patterns like
    // 'wfPluginVulnerability' / 'knownfile_vulnerability'.
    const pluginLookup = new Map();
    for (const p of plugins) {
      pluginLookup.set((p.slug || '').toLowerCase(), p);
      if (p.name) pluginLookup.set(p.name.toLowerCase(), p);
    }

    const vulns = [];
    for (const iss of scanIssues) {
      const type = (iss.type || '').toLowerCase();
      const title = iss.short_msg || iss.long_msg || '';
      // Only items that look like plugin-vuln findings
      const isVulnType = type.includes('vulnerab') || type.includes('pluginsecu') || /CVE-\d/i.test(title);
      if (!isVulnType) continue;
      // Try to identify which plugin
      let matched = null;
      for (const [key, p] of pluginLookup) {
        if (title.toLowerCase().includes(key) || (iss.file || '').toLowerCase().includes(key)) {
          matched = p; break;
        }
      }
      const cveMatch = title.match(/CVE-\d{4}-\d+/i);
      vulns.push({
        plugin: matched?.name || 'Unknown',
        slug: matched?.slug || null,
        installed_version: matched?.version || '--',
        plugin_file: matched?.file || null,
        plugin_active: matched?.active ?? null,
        severity: iss.severity || 'medium',
        cve: cveMatch ? cveMatch[0] : null,
        title,
        detected_at: iss.detected_at,
        recommendation: matched?.update_available ? `Update to ${matched.new_version || 'latest'}` : 'Review in Wordfence and patch',
      });
    }

    const outdatedCount = plugins.filter((p) => p.update_available && p.active).length;

    res.json({
      data: {
        vulnerabilities: vulns,
        plugins_checked: plugins.length,
        outdated_active_plugins: outdatedCount,
        critical: vulns.filter((v) => v.severity === 'critical').length,
        high: vulns.filter((v) => v.severity === 'high').length,
        medium: vulns.filter((v) => v.severity === 'medium').length,
        low: vulns.filter((v) => v.severity === 'low').length,
        wordfence_status: wfInstalled ? 'installed' : 'not_installed',
        wordfence_scan_findings_total: scanIssues.length,
        plugin_source: pluginErr ? 'failed' : 'plugin',
        plugin_list_error: pluginErr,
        data_source: 'wordfence_local_scan',
        data_source_note: 'CVE matches come from Wordfence scan findings on the site (local DB, auto-updated). Outdated plugins are the primary actionable signal.',
        checked_at: new Date().toISOString(),
      },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[vulnerabilities]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// --- GET /arion/sites/:siteId/pagespeed-history ---
// Returns snapshots in a shape that groups mobile + desktop per run_date so
// the Portal can draw a single chart with both lines.
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
      .query(`SELECT TOP 60 * FROM arion.site_pagespeed_snapshot
        WHERE tenant_id = @tenantId AND site_id = @siteId
        ORDER BY run_date DESC, created_at DESC`);

    // Group snapshots by run_date so each date has {mobile: {...}, desktop: {...}}
    const byDate = new Map();
    for (const row of result.recordset) {
      const dateKey = row.run_date instanceof Date ? row.run_date.toISOString().slice(0, 10) : String(row.run_date).slice(0, 10);
      if (!byDate.has(dateKey)) byDate.set(dateKey, { timestamp: dateKey, mobile: null, desktop: null });
      const bucket = byDate.get(dateKey);
      const snapshot = {
        performance: row.performance_score ?? (row.strategy === 'mobile' ? row.mobile_performance : row.desktop_performance),
        accessibility: row.accessibility_score ?? null,
        seo: row.seo_score ?? null,
        best_practices: row.best_practices_score ?? null,
        metrics: {
          lcp: row.lcp_ms,
          inp: row.inp_ms,
          cls: row.cls_score != null ? Number(row.cls_score) : null,
          fcp: row.fcp_ms,
          tbt: row.tbt_ms,
        },
        opportunities: row.opportunities ? (() => { try { return JSON.parse(row.opportunities); } catch { return []; } })() : [],
        crux_url: row.crux_url_json ? (() => { try { return JSON.parse(row.crux_url_json); } catch { return null; } })() : null,
        crux_origin: row.crux_origin_json ? (() => { try { return JSON.parse(row.crux_origin_json); } catch { return null; } })() : null,
        triggered_by: row.triggered_by ?? null,
      };
      // Back-compat: support old rows without strategy column
      const strat = row.strategy || (row.mobile_performance != null ? 'mobile' : 'desktop');
      bucket[strat] = snapshot;
      // Convenience shorthand fields the old Portal chart reads
      if (strat === 'mobile') bucket.mobileScore = snapshot.performance;
      if (strat === 'desktop') bucket.desktopScore = snapshot.performance;
    }

    const snapshots = Array.from(byDate.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    res.json({ data: { snapshots }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[pagespeed-history]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ════════════════════════════════════════════════════════════════════════
// IA PLUGIN DATA PROXY ROUTES (2026-04-20)
// All routes call the plugin's REST API via WP app password Basic auth.
// Every response carries pluginStatus so the UI can surface connectivity
// issues gracefully. Snapshot-cache upsert happens for endpoints that feed
// daily trend data; live fetch falls back to a DB-cached snapshot if the
// site is unreachable.
// ════════════════════════════════════════════════════════════════════════

function pluginResponseFallback(pool, tenantId, siteId) {
  // Fetch the most recent snapshot so the UI has something to render even
  // when the live site is unreachable.
  return pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1 snapshot_date, payload_json, captured_at
      FROM arion.site_plugin_snapshot
      WHERE site_id = @siteId AND tenant_id = @tenantId
      ORDER BY snapshot_date DESC
    `)
    .then((r) => {
      if (r.recordset.length === 0) return null;
      try { return { fallback: true, ...JSON.parse(r.recordset[0].payload_json || '{}'), snapshot_date: r.recordset[0].snapshot_date, captured_at: r.recordset[0].captured_at }; }
      catch { return null; }
    })
    .catch(() => null);
}

async function runPluginProxy(req, res, fn, label) {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    if (!site.domain) return res.status(409).json({ error: { code: 'NOT_READY', message: 'Site has no domain configured', status: 409 } });

    const result = await fn(site, pool);
    res.json({
      data: result.data || null,
      plugin_status: result.pluginStatus || 'connected',
      errors: result.errors || [],
      fallback: Boolean(result.fallback),
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error(`[plugin:${label}]`, err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
}

// GET /arion/sites/:siteId/plugin/status — quick connection check
router.get('/sites/:siteId/plugin/status', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.status(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'status'));

// GET /arion/sites/:siteId/plugin/health — plugin health + WP env
router.get('/sites/:siteId/plugin/health', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.health(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'health'));

// GET /arion/sites/:siteId/plugin/security — aggregated security pull
router.get('/sites/:siteId/plugin/security', (req, res) => runPluginProxy(req, res, async (site, pool) => {
  const [wf, ch, users] = await Promise.all([
    pluginApi.securityWordfence(site),
    pluginApi.securityCoreHealth(site),
    pluginApi.securityUsers(site),
  ]);

  // If everything failed, pull the last snapshot
  if (!wf.ok && !ch.ok && !users.ok) {
    const fallback = await pluginResponseFallback(pool, req.tenant.tenantId, req.params.siteId);
    if (fallback) return { data: fallback.security || null, pluginStatus: wf.pluginStatus || 'unreachable', errors: [wf.errorText, ch.errorText, users.errorText].filter(Boolean), fallback: true };
  }

  return {
    data: {
      wordfence: wf.data || null,
      core_health: ch.data || null,
      users: users.data || null,
    },
    pluginStatus: wf.ok ? wf.pluginStatus : (ch.ok ? ch.pluginStatus : users.pluginStatus) || 'unreachable',
    errors: [
      !wf.ok && `wordfence: ${wf.errorText}`,
      !ch.ok && `core_health: ${ch.errorText}`,
      !users.ok && `users: ${users.errorText}`,
    ].filter(Boolean),
  };
}, 'security'));

// GET /arion/sites/:siteId/plugin/performance — aggregated performance pull
router.get('/sites/:siteId/plugin/performance', (req, res) => runPluginProxy(req, res, async (site, pool) => {
  const [ls, srv, cron] = await Promise.all([
    pluginApi.perfLitespeed(site),
    pluginApi.perfServer(site),
    pluginApi.perfCron(site),
  ]);

  if (!ls.ok && !srv.ok && !cron.ok) {
    const fallback = await pluginResponseFallback(pool, req.tenant.tenantId, req.params.siteId);
    if (fallback) return { data: fallback.performance || null, pluginStatus: 'unreachable', errors: [], fallback: true };
  }

  return {
    data: {
      litespeed: ls.data || null,
      server: srv.data || null,
      cron: cron.data || null,
    },
    pluginStatus: [ls, srv, cron].find((r) => r.ok)?.pluginStatus || 'unreachable',
    errors: [
      !ls.ok && `litespeed: ${ls.errorText}`,
      !srv.ok && `server: ${srv.errorText}`,
      !cron.ok && `cron: ${cron.errorText}`,
    ].filter(Boolean),
  };
}, 'performance'));

// GET /arion/sites/:siteId/plugin/content-aggregate — content summary + RankMath
router.get('/sites/:siteId/plugin/content-aggregate', (req, res) => runPluginProxy(req, res, async (site) => {
  const [summary, rm] = await Promise.all([
    pluginApi.contentSummary(site),
    pluginApi.contentSeoAgg(site),
  ]);
  return {
    data: { summary: summary.data || null, seo: rm.data || null },
    pluginStatus: summary.ok ? summary.pluginStatus : rm.pluginStatus,
    errors: [!summary.ok && `summary: ${summary.errorText}`, !rm.ok && `seo: ${rm.errorText}`].filter(Boolean),
  };
}, 'content-aggregate'));

// GET /arion/sites/:siteId/plugin/theme
router.get('/sites/:siteId/plugin/theme', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.theme(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'theme'));

// ─────────────────────────────────────────────────────────────────────────
// v2.0.7 analytics proxy routes — new Portal visual-first data endpoints
// ─────────────────────────────────────────────────────────────────────────

router.get('/sites/:siteId/plugin/security/wordfence-full', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.securityWordfenceFull(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'wordfence-full'));

router.get('/sites/:siteId/plugin/security/scan-issues', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.securityScanIssues(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'scan-issues'));

router.post('/sites/:siteId/plugin/security/wordfence-config', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.securityWfConfig(site, req.body || {});
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'wordfence-config'));

router.post('/sites/:siteId/plugin/cache/purge', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.purgeCache(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'purge-cache'));

// v2.0.10 — LiteSpeed config GET + POST (full settings)
router.get('/sites/:siteId/plugin/litespeed/config', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.litespeedConfigGet(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'litespeed-config-get'));

router.post('/sites/:siteId/plugin/litespeed/config', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.litespeedConfigSet(site, req.body || {});
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'litespeed-config-set'));

// v2.0.10 — One-click "Apply IA Defaults" across every managed plugin.
// Also fires a PageSpeed run automatically since the performance config
// just changed and we want a fresh baseline.
router.post('/sites/:siteId/plugin/onboarding/apply-defaults', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const r = await pluginApi.applyIADefaults(site);

    // Kick off a fresh PSI run — fire-and-forget, results land in snapshot table
    if (site.domain) {
      triggerOnboardingPageSpeed(pool, tenantId, siteId, site.domain);
    }

    res.json({
      data: r.data || { applied_at: new Date().toISOString(), results: {} },
      plugin_status: r.pluginStatus,
      errors: r.errors || [],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString(), psi_triggered: !!site.domain },
    });
  } catch (err) {
    console.error('[apply-ia-defaults]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

router.get('/sites/:siteId/plugin/content/publishing-pace', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentPace(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-pace'));

router.get('/sites/:siteId/plugin/content/age-distribution', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentAgeDist(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-age'));

router.get('/sites/:siteId/plugin/content/authors', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentAuthors(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-authors'));

router.get('/sites/:siteId/plugin/content/categories', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentCategories(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-categories'));

router.get('/sites/:siteId/plugin/content/word-count-distribution', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentWordCountDist(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-wordcount'));

router.get('/sites/:siteId/plugin/content/activity-calendar', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentActivityCal(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-activity'));

router.get('/sites/:siteId/plugin/content/seo-detail', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.contentSeoDetail(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'content-seo-detail'));

router.get('/sites/:siteId/plugin/plugins/risk-analysis', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.pluginsRiskAnalysis(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'plugins-risk'));

// GET /arion/sites/:siteId/plugin/forms-summary
router.get('/sites/:siteId/plugin/forms-summary', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.formsSummary(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'forms-summary'));

// GET /arion/sites/:siteId/plugin/updates — all available updates
router.get('/sites/:siteId/plugin/updates', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.updatesAvailable(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'updates'));

// GET /arion/sites/:siteId/plugin/plugins — plugin inventory (live)
router.get('/sites/:siteId/plugin/plugins', (req, res) => runPluginProxy(req, res, async (site, pool) => {
  const r = await pluginApi.plugins(site);
  if (r.ok && Array.isArray(r.data)) {
    // Update inventory table (replace)
    try {
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, req.params.siteId)
        .query('DELETE FROM arion.site_plugin_inventory WHERE site_id = @siteId AND captured_at < DATEADD(hour, -1, SYSDATETIMEOFFSET())');
      for (const p of r.data) {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, req.tenant.tenantId)
          .input('siteId', sql.UniqueIdentifier, req.params.siteId)
          .input('pluginFile', sql.NVarChar(300), String(p.file || ''))
          .input('pluginSlug', sql.NVarChar(200), p.slug || null)
          .input('pluginName', sql.NVarChar(300), p.name || null)
          .input('currentVersion', sql.NVarChar(40), p.version || null)
          .input('newVersion', sql.NVarChar(40), null)
          .input('updateAvailable', sql.Bit, p.update_available ? 1 : 0)
          .input('isActive', sql.Bit, p.active ? 1 : 0)
          .input('author', sql.NVarChar(200), p.author || null)
          .query(`
            INSERT INTO arion.site_plugin_inventory
              (tenant_id, site_id, plugin_file, plugin_slug, plugin_name,
               current_version, new_version, update_available, is_active, author)
            VALUES (@tenantId, @siteId, @pluginFile, @pluginSlug, @pluginName,
                    @currentVersion, @newVersion, @updateAvailable, @isActive, @author)
          `);
      }
    } catch (e) { console.warn('[plugin:plugins:inventory-write]', e.message); }
  }
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'plugins'));

// POST /arion/sites/:siteId/plugin/updates/plugin — trigger plugin update
router.post('/sites/:siteId/plugin/updates/plugin', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const pluginFile = req.body?.plugin;
  const userEmail = req.user?.email || req.user?.userId || null;

  if (!pluginFile) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'plugin is required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    // Log start
    const logResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('updateType', sql.NVarChar(20), 'plugin')
      .input('target', sql.NVarChar(300), pluginFile)
      .input('status', sql.NVarChar(20), 'pending')
      .input('triggeredBy', sql.NVarChar(200), userEmail)
      .query(`
        INSERT INTO arion.site_plugin_update_log
          (tenant_id, site_id, update_type, target, status, triggered_by)
        OUTPUT inserted.log_id
        VALUES (@tenantId, @siteId, @updateType, @target, @status, @triggeredBy)
      `);
    const logId = logResult.recordset[0].log_id;

    const r = await pluginApi.updatePlugin(site, pluginFile);

    const finalStatus = r.ok ? 'success' : 'failure';
    await pool.request()
      .input('logId', sql.UniqueIdentifier, logId)
      .input('status', sql.NVarChar(20), finalStatus)
      .input('errorMsg', sql.NVarChar(sql.MAX), r.ok ? null : (r.errorText || 'unknown'))
      .query(`
        UPDATE arion.site_plugin_update_log
        SET status = @status, error_message = @errorMsg, completed_at = SYSDATETIMEOFFSET()
        WHERE log_id = @logId
      `);

    res.json({
      data: { success: r.ok, plugin: pluginFile, log_id: logId, detail: r.data || null },
      plugin_status: r.pluginStatus,
      errors: r.ok ? [] : [r.errorText || 'update failed'],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[plugin:updates:plugin]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/plugin/updates/theme — trigger theme update
router.post('/sites/:siteId/plugin/updates/theme', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const stylesheet = req.body?.stylesheet;
  const userEmail = req.user?.email || req.user?.userId || null;

  if (!stylesheet) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'stylesheet is required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const logResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('updateType', sql.NVarChar(20), 'theme')
      .input('target', sql.NVarChar(300), stylesheet)
      .input('status', sql.NVarChar(20), 'pending')
      .input('triggeredBy', sql.NVarChar(200), userEmail)
      .query(`INSERT INTO arion.site_plugin_update_log (tenant_id, site_id, update_type, target, status, triggered_by) OUTPUT inserted.log_id VALUES (@tenantId, @siteId, @updateType, @target, @status, @triggeredBy)`);
    const logId = logResult.recordset[0].log_id;

    const r = await pluginApi.updateTheme(site, stylesheet);

    await pool.request()
      .input('logId', sql.UniqueIdentifier, logId)
      .input('status', sql.NVarChar(20), r.ok ? 'success' : 'failure')
      .input('errorMsg', sql.NVarChar(sql.MAX), r.ok ? null : (r.errorText || 'unknown'))
      .query(`UPDATE arion.site_plugin_update_log SET status = @status, error_message = @errorMsg, completed_at = SYSDATETIMEOFFSET() WHERE log_id = @logId`);

    res.json({
      data: { success: r.ok, stylesheet, log_id: logId },
      plugin_status: r.pluginStatus,
      errors: r.ok ? [] : [r.errorText || 'update failed'],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[plugin:updates:theme]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/plugin/updates/core — trigger WP core update
router.post('/sites/:siteId/plugin/updates/core', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const userEmail = req.user?.email || req.user?.userId || null;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const logResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('updateType', sql.NVarChar(20), 'core')
      .input('target', sql.NVarChar(300), 'wordpress-core')
      .input('status', sql.NVarChar(20), 'pending')
      .input('triggeredBy', sql.NVarChar(200), userEmail)
      .query(`INSERT INTO arion.site_plugin_update_log (tenant_id, site_id, update_type, target, status, triggered_by) OUTPUT inserted.log_id VALUES (@tenantId, @siteId, @updateType, @target, @status, @triggeredBy)`);
    const logId = logResult.recordset[0].log_id;

    const r = await pluginApi.updateCore(site);

    await pool.request()
      .input('logId', sql.UniqueIdentifier, logId)
      .input('status', sql.NVarChar(20), r.ok ? 'success' : 'failure')
      .input('errorMsg', sql.NVarChar(sql.MAX), r.ok ? null : (r.errorText || 'unknown'))
      .query(`UPDATE arion.site_plugin_update_log SET status = @status, error_message = @errorMsg, completed_at = SYSDATETIMEOFFSET() WHERE log_id = @logId`);

    res.json({
      data: { success: r.ok, log_id: logId, detail: r.data || null },
      plugin_status: r.pluginStatus,
      errors: r.ok ? [] : [r.errorText || 'update failed'],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[plugin:updates:core]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites/:siteId/plugin/performance/image-optimize — trigger LiteSpeed bulk image optim
router.post('/sites/:siteId/plugin/performance/image-optimize', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const r = await pluginApi.imageOptimize(site);

    res.json({
      data: r.data || { success: r.ok },
      plugin_status: r.pluginStatus,
      errors: r.ok ? [] : [r.errorText || 'image optimize failed'],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[plugin:performance:image-optimize]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/plugin/security-events — read stored security events from DB
router.get('/sites/:siteId/plugin/security-events', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit) event_id, event_type, severity, title, detail_json, source_ip, occurred_at, ack_at
        FROM arion.site_security_event
        WHERE site_id = @siteId AND tenant_id = @tenantId
        ORDER BY occurred_at DESC
      `);
    res.json({ data: { events: result.recordset }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[plugin:security-events]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/plugin/auto-update-config — read WP auto-update settings
router.get('/sites/:siteId/plugin/auto-update-config', (req, res) => runPluginProxy(req, res, async (site) => {
  const r = await pluginApi.autoUpdateConfig(site);
  return { data: r.data, pluginStatus: r.pluginStatus, errors: r.errors };
}, 'auto-update-config'));

// POST /arion/sites/:siteId/plugin/auto-update-config — toggle auto-update
// Body: { plugin?, theme?, enabled?, all_plugins?, all_themes? }
router.post('/sites/:siteId/plugin/auto-update-config', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const site = await getSiteForTenant(pool, tenantId, siteId);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const r = await pluginApi.setAutoUpdate(site, req.body || {});
    res.json({
      data: r.data || null,
      plugin_status: r.pluginStatus,
      errors: r.ok ? [] : [r.errorText || 'auto-update toggle failed'],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[plugin:auto-update-config:post]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/plugin/updates-log — history of update actions
router.get('/sites/:siteId/plugin/updates-log', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 50 log_id, update_type, target, previous_version, new_version,
               status, error_message, triggered_by, triggered_at, completed_at
        FROM arion.site_plugin_update_log
        WHERE site_id = @siteId AND tenant_id = @tenantId
        ORDER BY triggered_at DESC
      `);
    res.json({ data: { entries: result.recordset }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[plugin:updates-log]', err);
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

    // v2.0.13 SMART AUTO-SELECT — auto-pick GA4 + GSC when there's no ambiguity.
    // Reduces friction: typical small-biz client has one GA4 property + one
    // GSC site for their domain. The picker only really needs to show when
    // the user manages multiple sites/properties on one Google account.
    const autoSelected = { ga4: null, gsc: null };
    let currentGa4 = site.ga4_property_id || null;
    let currentGsc = site.gsc_site_url || null;

    if (!currentGa4 && ga4Properties.length > 0) {
      // Robust match: strip non-alphanumeric, check both directions
      const siteHost = String(site.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      const cleanHost = siteHost.toLowerCase().replace(/[^a-z0-9]/g, '');
      const ga4Match = ga4Properties.find((p) => {
        const cleanDn = (p.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!cleanDn) return false;
        return cleanHost.includes(cleanDn) || cleanDn.includes(cleanHost);
      });
      const ga4Pick = ga4Match || (ga4Properties.length === 1 ? ga4Properties[0] : null);
      if (ga4Pick) {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('ga4PropertyId', sql.NVarChar(40), ga4Pick.propertyId)
          .query('UPDATE arion.site SET ga4_property_id = @ga4PropertyId WHERE tenant_id = @tenantId AND site_id = @siteId');
        currentGa4 = ga4Pick.propertyId;
        autoSelected.ga4 = { propertyId: ga4Pick.propertyId, displayName: ga4Pick.displayName, reason: ga4Match ? 'domain_match' : 'only_property' };
      }
    }

    if (!currentGsc && gscSites.length > 0) {
      const siteHost = String(site.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
      const gscMatch = gscSites.find((s) => {
        const sHost = String(s.siteUrl || '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
        return sHost === siteHost;
      });
      const gscPick = gscMatch || (gscSites.length === 1 ? gscSites[0] : null);
      if (gscPick) {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('gscSiteUrl', sql.NVarChar(500), gscPick.siteUrl)
          .query('UPDATE arion.site SET gsc_site_url = @gscSiteUrl WHERE tenant_id = @tenantId AND site_id = @siteId');
        currentGsc = gscPick.siteUrl;
        autoSelected.gsc = { siteUrl: gscPick.siteUrl, reason: gscMatch ? 'domain_match' : 'only_site' };
      }
    }

    res.json({
      data: {
        ga4Properties, gscSites,
        currentGa4PropertyId: currentGa4,
        currentGscSiteUrl: currentGsc,
        auto_selected: autoSelected,
      },
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

// ── IA Insights v5.x — score history + prior-period lookup ───────────
//
// Frontend trend engines run client-side. The endpoints below let the
// Trends page persist the resulting scores per period and look up the
// prior period's scores for ghost-bar comparison.

// POST /arion/ia-insights/scores — upsert current-period scores
router.post('/ia-insights/scores', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const { siteId, periodStart, periodEnd, scores } = req.body || {};
    if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required' } });
    if (!scores || typeof scores !== 'object') return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'scores object required' } });
    if (!periodEnd) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'periodEnd required (YYYY-MM-DD)' } });
    const periodStartDate = periodStart || new Date(new Date(periodEnd).getTime() - 90 * 86400000).toISOString().slice(0, 10);

    const pool = await getServicesPool();
    let written = 0;
    for (const [reportKey, scoreVal] of Object.entries(scores)) {
      const intScore = Math.max(0, Math.min(100, Math.round(Number(scoreVal) || 0)));
      try {
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('siteId', sql.UniqueIdentifier, siteId)
          .input('reportKey', sql.NVarChar(40), reportKey)
          .input('periodEnd', sql.Date, periodEnd)
          .input('periodStart', sql.Date, periodStartDate)
          .input('score', sql.Int, intScore)
          .query(`MERGE arion.ia_insights_score_history AS tgt
                  USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @reportKey AS report_key, @periodEnd AS period_end) AS src
                  ON tgt.tenant_id=src.tenant_id AND tgt.site_id=src.site_id AND tgt.report_key=src.report_key AND tgt.period_end=src.period_end
                  WHEN MATCHED THEN UPDATE SET score=@score, period_start=@periodStart, updated_at=SYSUTCDATETIME()
                  WHEN NOT MATCHED THEN INSERT (tenant_id, site_id, report_key, period_end, period_start, score)
                    VALUES (@tenantId, @siteId, @reportKey, @periodEnd, @periodStart, @score);`);
        written++;
      } catch (e) { console.warn('[ia-insights/scores] upsert failed', reportKey, e.message); }
    }
    res.json({ ok: true, written });
  } catch (err) {
    console.error('[ia-insights/scores POST]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// GET /arion/ia-insights/prior-scores?siteId=&beforeDate=YYYY-MM-DD
// Returns the most recent score history row per report_key whose period_end
// is strictly before the supplied date — i.e. the "prior period" comparison.
router.get('/ia-insights/prior-scores', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const siteId = req.query.siteId;
    const beforeDate = req.query.beforeDate || new Date().toISOString().slice(0, 10);
    if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required' } });
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('beforeDate', sql.Date, beforeDate)
      .query(`WITH ranked AS (
                SELECT report_key, score, period_end,
                       ROW_NUMBER() OVER (PARTITION BY report_key ORDER BY period_end DESC) AS rn
                FROM arion.ia_insights_score_history
                WHERE tenant_id=@tenantId AND site_id=@siteId AND period_end < @beforeDate
              )
              SELECT report_key, score, period_end FROM ranked WHERE rn = 1`);
    const scores = {};
    for (const row of r.recordset) scores[row.report_key] = { score: row.score, periodEnd: row.period_end };
    res.json({ data: scores });
  } catch (err) {
    console.error('[ia-insights/prior-scores]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// GET /arion/ia-insights/score-history?siteId=&reportKey=&limit=12
// Returns the last N periods of scores for a single report — used for
// sparkline trend within an expanded report card.
router.get('/ia-insights/score-history', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const siteId = req.query.siteId;
    const reportKey = req.query.reportKey;
    const limit = Math.min(60, parseInt(req.query.limit) || 12);
    if (!siteId || !reportKey) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId and reportKey required' } });
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('reportKey', sql.NVarChar(40), reportKey)
      .input('limit', sql.Int, limit)
      .query(`SELECT TOP (@limit) period_end, score
              FROM arion.ia_insights_score_history
              WHERE tenant_id=@tenantId AND site_id=@siteId AND report_key=@reportKey
              ORDER BY period_end DESC`);
    res.json({ data: r.recordset.reverse() });
  } catch (err) {
    console.error('[ia-insights/score-history]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// GET /arion/ia-insights/service-area?siteId=  — read tenant service area config
// PUT /arion/ia-insights/service-area — update
router.get('/ia-insights/service-area', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const siteId = req.query.siteId;
    if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required' } });
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId).input('siteId', sql.UniqueIdentifier, siteId)
      .query(`SELECT service_area_json, service_category FROM arion.site WHERE site_id=@siteId AND tenant_id=@tenantId`);
    const raw = r.recordset[0]?.service_area_json || null;
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    const serviceCategory = r.recordset[0]?.service_category || null;
    res.json({ data, service_category: serviceCategory });
  } catch (err) {
    console.error('[ia-insights/service-area GET]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.put('/ia-insights/service-area', async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const { siteId, serviceArea, serviceCategory } = req.body || {};
    if (!siteId) return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required' } });
    const pool = await getServicesPool();
    const sets = [];
    const r = pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).input('siteId', sql.UniqueIdentifier, siteId);
    // Only touch keys the caller passed (so partial updates don't blank fields).
    if ('serviceArea' in (req.body || {})) {
      r.input('json', sql.NVarChar(sql.MAX), serviceArea ? JSON.stringify(serviceArea) : null);
      sets.push('service_area_json=@json');
    }
    if ('serviceCategory' in (req.body || {})) {
      r.input('cat', sql.NVarChar(60), serviceCategory || null);
      sets.push('service_category=@cat');
    }
    if (!sets.length) return res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'serviceArea or serviceCategory required' } });
    await r.query(`UPDATE arion.site SET ${sets.join(', ')} WHERE site_id=@siteId AND tenant_id=@tenantId`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ia-insights/service-area PUT]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// GET /arion/ia-insights/benchmarks?category=  — list industry benchmarks
router.get('/ia-insights/benchmarks', async (req, res) => {
  try {
    const category = req.query.category;
    const pool = await getServicesPool();
    const r = pool.request();
    let q = `SELECT service_category, metric_key, benchmark_value, units, notes FROM arion.ia_insights_benchmark`;
    if (category) { r.input('cat', sql.NVarChar(60), category); q += ' WHERE service_category=@cat'; }
    q += ' ORDER BY service_category, metric_key';
    const rs = await r.query(q);
    res.json({ data: rs.recordset });
  } catch (err) {
    console.error('[ia-insights/benchmarks]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
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
