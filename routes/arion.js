import express from "express";
import sql from "mssql";
import { getServicesPool } from "../db/servicesPool.js";
import { cleanString, getEmailFromClaims } from "../lib/claims.js";
import { asNumber, pickDefinedEntries, toBoolean } from "../lib/validation.js";

const router = express.Router();

const PACKAGE_CODES = new Set(["LITE", "STANDARD", "PRO", "BUSINESS"]);
const PROVIDER_CODES = new Set([
  "GOOGLE_ANALYTICS",
  "GOOGLE_SEARCH_CONSOLE",
  "BING_WEBMASTER",
  "GOOGLE_BUSINESS_PROFILE",
  "APPLE_BUSINESS_CONNECT",
  "BING_PLACES",
  "SE_RANKING",
]);

function normalizePackageCode(value) {
  const normalized = cleanString(value)?.toUpperCase() || null;
  if (!normalized) return null;
  if (!PACKAGE_CODES.has(normalized)) {
    throw new Error(`Invalid packageCode. Expected one of: ${Array.from(PACKAGE_CODES).join(", ")}`);
  }
  return normalized;
}

function normalizeProviderCode(value) {
  const normalized = cleanString(value)?.toUpperCase() || null;
  if (!normalized) return null;
  if (!PROVIDER_CODES.has(normalized)) {
    throw new Error(`Invalid providerCode. Expected one of: ${Array.from(PROVIDER_CODES).join(", ")}`);
  }
  return normalized;
}

function mapSiteRow(row) {
  if (!row) return null;
  return {
    siteId: row.site_id,
    tenantId: row.tenant_id,
    wpUrl: row.wp_url,
    status: row.status,
    hostingerWebsiteId: row.hostinger_website_id,
    hostingerPlanId: row.hostinger_plan_id,
    templateKey: row.template_key,
    primaryDomain: row.primary_domain,
    sslStatus: row.ssl_status,
    isTest: row.is_test === true || row.is_test === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    packageCode: row.package_code,
    packagePriceUsd: row.package_price_usd,
    isEcommerceEnabled: row.is_ecommerce_enabled === true || row.is_ecommerce_enabled === 1,
    notes: row.notes,
  };
}

function mapSiteListRow(row) {
  return {
    ...mapSiteRow(row),
    health: {
      siteStatus: row.health_site_status,
      sslStatus: row.health_ssl_status,
      pluginUpdatesAvailable: row.plugin_updates_available,
      themeUpdatesAvailable: row.theme_updates_available,
      performanceScore: row.performance_score,
      formDeliveryStatus: row.form_delivery_status,
      lastHealthCheckAt: row.last_health_check_at,
    },
    seo: {
      ga4Connected: Boolean(row.ga4_connected),
      searchConsoleConnected: Boolean(row.search_console_connected),
      bingWebmasterConnected: Boolean(row.bing_webmaster_connected),
      sitemapDetected: Boolean(row.sitemap_detected),
      indexedPages: row.indexed_pages,
      lastCheckedAt: row.seo_last_checked_at,
    },
    latestSnapshot: row.latest_snapshot_date
      ? {
          snapshotDate: row.latest_snapshot_date,
          sessions: row.sessions,
          users: row.users,
          pageviews: row.pageviews,
          conversions: row.conversions,
          leads: row.leads,
          orders: row.orders,
          revenueUsd: row.revenue_usd,
          sourceSystem: row.source_system,
        }
      : null,
    integrationCount: row.integration_count || 0,
    openRequestCount: row.open_request_count || 0,
  };
}

function mapRequestRow(row) {
  return {
    siteRequestId: row.site_request_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    requestType: row.request_type,
    requestStatus: row.request_status,
    requestedByEmail: row.requested_by_email,
    notes: row.notes,
    requestedAt: row.requested_at,
    closedAt: row.closed_at,
    isTest: Boolean(row.is_test),
  };
}

function mapIntegrationRow(row) {
  return {
    siteIntegrationId: row.site_integration_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    providerCode: row.provider_code,
    integrationAccountId: row.integration_account_id,
    status: row.status,
    config: safeJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPluginRow(row) {
  return {
    sitePluginId: row.site_plugin_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    pluginKey: row.plugin_key,
    pluginName: row.plugin_name,
    pluginVersion: row.plugin_version,
    isRequired: Boolean(row.is_required),
    isActive: Boolean(row.is_active),
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

function mapAnalyticsRow(row) {
  return {
    snapshotId: row.snapshot_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    snapshotDate: row.snapshot_date,
    sessions: row.sessions,
    users: row.users,
    pageviews: row.pageviews,
    conversions: row.conversions,
    leads: row.leads,
    orders: row.orders,
    revenueUsd: row.revenue_usd,
    sourceSystem: row.source_system,
    createdAt: row.created_at,
  };
}

function mapEventRow(row) {
  return {
    siteEventId: row.site_event_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    eventType: row.event_type,
    eventStatus: row.event_status,
    message: row.message,
    details: safeJson(row.details_json),
    jobKey: row.job_key,
    isTest: Boolean(row.is_test),
    createdAt: row.created_at,
  };
}

function mapPresenceRow(row) {
  if (!row) return null;
  return {
    sitePresenceId: row.site_presence_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    businessName: row.business_name,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    googleBusinessProfileUrl: row.google_business_profile_url,
    appleBusinessConnectUrl: row.apple_business_connect_url,
    bingPlacesUrl: row.bing_places_url,
    googleMapsUrl: row.google_maps_url,
    appleMapsUrl: row.apple_maps_url,
    bingMapsUrl: row.bing_maps_url,
    mapEmbedUrl: row.map_embed_url,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function mapSeoRow(row) {
  if (!row) return null;
  return {
    siteSeoStatusId: row.site_seo_status_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    ga4Connected: Boolean(row.ga4_connected),
    searchConsoleConnected: Boolean(row.search_console_connected),
    bingWebmasterConnected: Boolean(row.bing_webmaster_connected),
    sitemapDetected: Boolean(row.sitemap_detected),
    robotsOk: row.robots_ok === null || row.robots_ok === undefined ? null : Boolean(row.robots_ok),
    indexedPages: row.indexed_pages,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHealthRow(row) {
  if (!row) return null;
  return {
    siteHealthId: row.site_health_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    wordpressVersion: row.wordpress_version,
    phpVersion: row.php_version,
    pluginUpdatesAvailable: row.plugin_updates_available,
    themeUpdatesAvailable: row.theme_updates_available,
    sslStatus: row.ssl_status,
    siteStatus: row.site_status,
    lastHealthCheckAt: row.last_health_check_at,
    formDeliveryStatus: row.form_delivery_status,
    lastFormTestAt: row.last_form_test_at,
    performanceScore: row.performance_score,
    lastPerfCheckAt: row.last_perf_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

async function loadSiteOr404(pool, tenantId, siteId, res) {
  const result = await pool
    .request()
    .input("tenant_id", sql.UniqueIdentifier, tenantId)
    .input("site_id", sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1 *
      FROM arion.sites
      WHERE tenant_id = @tenant_id
        AND site_id = @site_id;
    `);

  const site = result.recordset[0] || null;
  if (!site) {
    res.status(404).json({ error: "Site not found." });
    return null;
  }

  return site;
}

router.get("/providers", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const result = await pool.request().query(`
      SELECT provider_code, provider_name, is_active
      FROM ref.integration_providers
      WHERE is_active = 1
      ORDER BY provider_name;
    `);

    return res.status(200).json({
      providers: result.recordset.map((row) => ({
        providerCode: row.provider_code,
        providerName: row.provider_name,
        isActive: Boolean(row.is_active),
      })),
    });
  } catch (err) {
    console.error("[arion.providers] error:", err);
    return res.status(500).json({ error: "Failed to load providers", details: err.message });
  }
});

router.get("/sites", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const pool = await getServicesPool();

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT
          s.*,
          h.site_status AS health_site_status,
          h.ssl_status AS health_ssl_status,
          h.plugin_updates_available,
          h.theme_updates_available,
          h.performance_score,
          h.form_delivery_status,
          h.last_health_check_at,
          seo.ga4_connected,
          seo.search_console_connected,
          seo.bing_webmaster_connected,
          seo.sitemap_detected,
          seo.indexed_pages,
          seo.last_checked_at AS seo_last_checked_at,
          snap.snapshot_date AS latest_snapshot_date,
          snap.sessions,
          snap.users,
          snap.pageviews,
          snap.conversions,
          snap.leads,
          snap.orders,
          snap.revenue_usd,
          snap.source_system,
          reqs.open_request_count,
          ints.integration_count
        FROM arion.sites s
        OUTER APPLY (
          SELECT TOP 1 *
          FROM arion.site_health h
          WHERE h.site_id = s.site_id
          ORDER BY h.updated_at DESC, h.created_at DESC
        ) h
        OUTER APPLY (
          SELECT TOP 1 *
          FROM arion.site_seo_status seo
          WHERE seo.site_id = s.site_id
          ORDER BY seo.updated_at DESC, seo.created_at DESC
        ) seo
        OUTER APPLY (
          SELECT TOP 1 *
          FROM arion.site_analytics_snapshot snap
          WHERE snap.site_id = s.site_id
          ORDER BY snap.snapshot_date DESC, snap.created_at DESC
        ) snap
        OUTER APPLY (
          SELECT COUNT(1) AS open_request_count
          FROM arion.site_requests reqs
          WHERE reqs.site_id = s.site_id
            AND reqs.request_status <> 'CLOSED'
        ) reqs
        OUTER APPLY (
          SELECT COUNT(1) AS integration_count
          FROM arion.site_integrations ints
          WHERE ints.site_id = s.site_id
            AND ints.status = 'ACTIVE'
        ) ints
        WHERE s.tenant_id = @tenant_id
        ORDER BY s.created_at DESC;
      `);

    return res.status(200).json({
      tenant: {
        tenantId: req.tenant.tenantId,
        tenantName: req.tenant.tenantName,
        tenantFullName: req.tenant.tenantFullName,
      },
      service: req.service,
      sites: result.recordset.map(mapSiteListRow),
    });
  } catch (err) {
    console.error("[arion.sites.list] error:", err);
    return res.status(500).json({ error: "Failed to load ARION sites", details: err.message });
  }
});

router.post("/sites", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const pool = await getServicesPool();

    const packageCode = normalizePackageCode(req.body?.packageCode);
    const packagePriceUsd = asNumber(req.body?.packagePriceUsd);
    const isEcommerceEnabled = toBoolean(req.body?.isEcommerceEnabled, false);
    const wpUrl = cleanString(req.body?.wpUrl);
    const status = cleanString(req.body?.status) || "PENDING_SETUP";

    if (!wpUrl) {
      return res.status(400).json({ error: "wpUrl is required." });
    }

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("wp_url", sql.NVarChar(1000), wpUrl)
      .input("status", sql.VarChar(50), status)
      .input("hostinger_website_id", sql.NVarChar(200), cleanString(req.body?.hostingerWebsiteId))
      .input("hostinger_plan_id", sql.NVarChar(200), cleanString(req.body?.hostingerPlanId))
      .input("template_key", sql.NVarChar(200), cleanString(req.body?.templateKey))
      .input("primary_domain", sql.NVarChar(400), cleanString(req.body?.primaryDomain))
      .input("ssl_status", sql.VarChar(50), cleanString(req.body?.sslStatus))
      .input("package_code", sql.VarChar(20), packageCode)
      .input("package_price_usd", sql.Decimal(10, 2), packagePriceUsd)
      .input("is_ecommerce_enabled", sql.Bit, isEcommerceEnabled)
      .input("notes", sql.NVarChar(2000), cleanString(req.body?.notes))
      .query(`
        DECLARE @new TABLE (site_id uniqueidentifier);
        INSERT INTO arion.sites (
          tenant_id,
          wp_url,
          status,
          hostinger_website_id,
          hostinger_plan_id,
          template_key,
          primary_domain,
          ssl_status,
          package_code,
          package_price_usd,
          is_ecommerce_enabled,
          notes
        )
        OUTPUT INSERTED.site_id INTO @new(site_id)
        VALUES (
          @tenant_id,
          @wp_url,
          @status,
          @hostinger_website_id,
          @hostinger_plan_id,
          @template_key,
          @primary_domain,
          @ssl_status,
          @package_code,
          @package_price_usd,
          @is_ecommerce_enabled,
          @notes
        );

        SELECT TOP 1 *
        FROM arion.sites
        WHERE site_id = (SELECT TOP 1 site_id FROM @new);
      `);

    return res.status(201).json({ site: mapSiteRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.sites.create] error:", err);
    return res.status(500).json({ error: "Failed to create ARION site", details: err.message });
  }
});

router.get("/sites/:siteId", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const site = await loadSiteOr404(pool, req.tenant.tenantId, req.params.siteId, res);
    if (!site) return;

    return res.status(200).json({ site: mapSiteRow(site) });
  } catch (err) {
    console.error("[arion.sites.get] error:", err);
    return res.status(500).json({ error: "Failed to load site", details: err.message });
  }
});

router.patch("/sites/:siteId", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const existing = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!existing) return;

    const packageCode = req.body?.packageCode === undefined ? undefined : normalizePackageCode(req.body?.packageCode);
    const packagePriceUsd = req.body?.packagePriceUsd === undefined ? undefined : asNumber(req.body?.packagePriceUsd);

    const updates = pickDefinedEntries({
      wp_url: cleanString(req.body?.wpUrl),
      status: cleanString(req.body?.status),
      hostinger_website_id: cleanString(req.body?.hostingerWebsiteId),
      hostinger_plan_id: cleanString(req.body?.hostingerPlanId),
      template_key: cleanString(req.body?.templateKey),
      primary_domain: cleanString(req.body?.primaryDomain),
      ssl_status: cleanString(req.body?.sslStatus),
      package_code: packageCode,
      package_price_usd: packagePriceUsd,
      is_ecommerce_enabled: req.body?.isEcommerceEnabled === undefined ? undefined : toBoolean(req.body?.isEcommerceEnabled, false),
      notes: cleanString(req.body?.notes),
    });

    if (!updates.length) {
      return res.status(400).json({ error: "No supported fields were provided." });
    }

    const request = pool.request().input("site_id", sql.UniqueIdentifier, siteId);
    const assignments = [];

    for (const [column, value] of updates) {
      const paramName = `p_${column}`;
      assignments.push(`${column} = @${paramName}`);
      if (["wp_url", "hostinger_website_id", "hostinger_plan_id", "template_key", "primary_domain", "notes"].includes(column)) {
        request.input(paramName, sql.NVarChar(sql.MAX), value);
      } else if (["status", "ssl_status", "package_code"].includes(column)) {
        request.input(paramName, sql.VarChar(50), value);
      } else if (column === "package_price_usd") {
        request.input(paramName, sql.Decimal(10, 2), value);
      } else if (column === "is_ecommerce_enabled") {
        request.input(paramName, sql.Bit, value);
      } else {
        request.input(paramName, value);
      }
    }

    const result = await request.query(`
      UPDATE arion.sites
      SET ${assignments.join(", ")},
          updated_at = SYSUTCDATETIME()
      WHERE site_id = @site_id;

      SELECT TOP 1 *
      FROM arion.sites
      WHERE site_id = @site_id;
    `);

    return res.status(200).json({ site: mapSiteRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.sites.patch] error:", err);
    return res.status(500).json({ error: "Failed to update site", details: err.message });
  }
});

router.get("/sites/:siteId/dashboard", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 *
        FROM arion.site_health
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;

        SELECT TOP 1 *
        FROM arion.site_seo_status
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;

        SELECT TOP 1 *
        FROM arion.site_presence
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;

        SELECT *
        FROM arion.site_integrations
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY provider_code;

        SELECT *
        FROM arion.site_plugins
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY is_required DESC, plugin_key;

        SELECT TOP 10 *
        FROM arion.site_requests
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY requested_at DESC;

        SELECT TOP 30 *
        FROM arion.site_analytics_snapshot
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY snapshot_date DESC, created_at DESC;

        SELECT TOP 10 *
        FROM arion.site_events
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY created_at DESC;
      `);

    const [healthRows, seoRows, presenceRows, integrationRows, pluginRows, requestRows, analyticsRows, eventRows] = result.recordsets;

    return res.status(200).json({
      tenant: {
        tenantId: req.tenant.tenantId,
        tenantName: req.tenant.tenantName,
        tenantFullName: req.tenant.tenantFullName,
      },
      site: mapSiteRow(site),
      health: mapHealthRow(healthRows?.[0]),
      seo: mapSeoRow(seoRows?.[0]),
      presence: mapPresenceRow(presenceRows?.[0]),
      integrations: (integrationRows || []).map(mapIntegrationRow),
      plugins: (pluginRows || []).map(mapPluginRow),
      requests: (requestRows || []).map(mapRequestRow),
      analytics: {
        latest: analyticsRows?.[0] ? mapAnalyticsRow(analyticsRows[0]) : null,
        series: (analyticsRows || []).slice().reverse().map(mapAnalyticsRow),
      },
      events: (eventRows || []).map(mapEventRow),
    });
  } catch (err) {
    console.error("[arion.dashboard] error:", err);
    return res.status(500).json({ error: "Failed to load ARION dashboard", details: err.message });
  }
});

router.get("/sites/:siteId/analytics", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("days", sql.Int, days)
      .query(`
        SELECT *
        FROM arion.site_analytics_snapshot
        WHERE tenant_id = @tenant_id
          AND site_id = @site_id
          AND snapshot_date >= DATEADD(DAY, -@days, CAST(SYSUTCDATETIME() AS date))
        ORDER BY snapshot_date ASC, created_at ASC;
      `);

    return res.status(200).json({ site: mapSiteRow(site), days, snapshots: result.recordset.map(mapAnalyticsRow) });
  } catch (err) {
    console.error("[arion.analytics] error:", err);
    return res.status(500).json({ error: "Failed to load analytics snapshots", details: err.message });
  }
});

router.get("/sites/:siteId/health", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 *
        FROM arion.site_health
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;
      `);

    return res.status(200).json({ site: mapSiteRow(site), health: mapHealthRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.health] error:", err);
    return res.status(500).json({ error: "Failed to load site health", details: err.message });
  }
});

router.get("/sites/:siteId/plugins", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT *
        FROM arion.site_plugins
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY is_required DESC, plugin_key;
      `);

    return res.status(200).json({ site: mapSiteRow(site), plugins: result.recordset.map(mapPluginRow) });
  } catch (err) {
    console.error("[arion.plugins] error:", err);
    return res.status(500).json({ error: "Failed to load site plugins", details: err.message });
  }
});

router.get("/sites/:siteId/presence", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 *
        FROM arion.site_presence
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;
      `);

    return res.status(200).json({ site: mapSiteRow(site), presence: mapPresenceRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.presence] error:", err);
    return res.status(500).json({ error: "Failed to load site presence", details: err.message });
  }
});

router.put("/sites/:siteId/presence", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const existing = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 site_presence_id
        FROM arion.site_presence
        WHERE tenant_id = @tenant_id AND site_id = @site_id;
      `);

    const presence = {
      business_name: cleanString(req.body?.businessName),
      phone: cleanString(req.body?.phone),
      address_line1: cleanString(req.body?.addressLine1),
      address_line2: cleanString(req.body?.addressLine2),
      city: cleanString(req.body?.city),
      state: cleanString(req.body?.state),
      postal_code: cleanString(req.body?.postalCode),
      country: cleanString(req.body?.country),
      google_business_profile_url: cleanString(req.body?.googleBusinessProfileUrl),
      apple_business_connect_url: cleanString(req.body?.appleBusinessConnectUrl),
      bing_places_url: cleanString(req.body?.bingPlacesUrl),
      google_maps_url: cleanString(req.body?.googleMapsUrl),
      apple_maps_url: cleanString(req.body?.appleMapsUrl),
      bing_maps_url: cleanString(req.body?.bingMapsUrl),
      map_embed_url: cleanString(req.body?.mapEmbedUrl),
    };

    if (existing.recordset[0]?.site_presence_id) {
      const request = pool
        .request()
        .input("site_presence_id", sql.UniqueIdentifier, existing.recordset[0].site_presence_id);
      const assignments = [];
      for (const [column, value] of Object.entries(presence)) {
        assignments.push(`${column} = @${column}`);
        request.input(column, sql.NVarChar(sql.MAX), value);
      }
      const result = await request.query(`
        UPDATE arion.site_presence
        SET ${assignments.join(", ")}, updated_at = SYSUTCDATETIME()
        WHERE site_presence_id = @site_presence_id;

        SELECT TOP 1 * FROM arion.site_presence WHERE site_presence_id = @site_presence_id;
      `);
      return res.status(200).json({ presence: mapPresenceRow(result.recordset[0]) });
    }

    const request = pool.request();
    request.input("tenant_id", sql.UniqueIdentifier, tenantId);
    request.input("site_id", sql.UniqueIdentifier, siteId);
    for (const [column, value] of Object.entries(presence)) {
      request.input(column, sql.NVarChar(sql.MAX), value);
    }
    const result = await request.query(`
      DECLARE @new TABLE (site_presence_id uniqueidentifier);
      INSERT INTO arion.site_presence (
        tenant_id,
        site_id,
        business_name,
        phone,
        address_line1,
        address_line2,
        city,
        state,
        postal_code,
        country,
        google_business_profile_url,
        apple_business_connect_url,
        bing_places_url,
        google_maps_url,
        apple_maps_url,
        bing_maps_url,
        map_embed_url
      )
      OUTPUT INSERTED.site_presence_id INTO @new(site_presence_id)
      VALUES (
        @tenant_id,
        @site_id,
        @business_name,
        @phone,
        @address_line1,
        @address_line2,
        @city,
        @state,
        @postal_code,
        @country,
        @google_business_profile_url,
        @apple_business_connect_url,
        @bing_places_url,
        @google_maps_url,
        @apple_maps_url,
        @bing_maps_url,
        @map_embed_url
      );

      SELECT TOP 1 *
      FROM arion.site_presence
      WHERE site_presence_id = (SELECT TOP 1 site_presence_id FROM @new);
    `);

    return res.status(201).json({ presence: mapPresenceRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.presence.put] error:", err);
    return res.status(500).json({ error: "Failed to upsert site presence", details: err.message });
  }
});

router.get("/sites/:siteId/seo", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 *
        FROM arion.site_seo_status
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;
      `);

    return res.status(200).json({ site: mapSiteRow(site), seo: mapSeoRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.seo] error:", err);
    return res.status(500).json({ error: "Failed to load site SEO status", details: err.message });
  }
});

router.get("/sites/:siteId/integrations", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT *
        FROM arion.site_integrations
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY provider_code;
      `);

    return res.status(200).json({ site: mapSiteRow(site), integrations: result.recordset.map(mapIntegrationRow) });
  } catch (err) {
    console.error("[arion.integrations.get] error:", err);
    return res.status(500).json({ error: "Failed to load site integrations", details: err.message });
  }
});

router.put("/sites/:siteId/integrations/:providerCode", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const providerCode = normalizeProviderCode(req.params.providerCode);
    const status = cleanString(req.body?.status)?.toUpperCase() || "ACTIVE";
    const integrationAccountId = cleanString(req.body?.integrationAccountId) || null;
    const configJson = req.body?.config ? JSON.stringify(req.body.config) : (typeof req.body?.configJson === "string" ? req.body.configJson : null);

    const existing = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("provider_code", sql.VarChar(50), providerCode)
      .query(`
        SELECT TOP 1 site_integration_id
        FROM arion.site_integrations
        WHERE tenant_id = @tenant_id
          AND site_id = @site_id
          AND provider_code = @provider_code
        ORDER BY updated_at DESC, created_at DESC;
      `);

    if (existing.recordset[0]?.site_integration_id) {
      const result = await pool
        .request()
        .input("site_integration_id", sql.UniqueIdentifier, existing.recordset[0].site_integration_id)
        .input("integration_account_id", sql.UniqueIdentifier, integrationAccountId)
        .input("status", sql.VarChar(50), status)
        .input("config_json", sql.NVarChar(sql.MAX), configJson)
        .query(`
          UPDATE arion.site_integrations
          SET integration_account_id = @integration_account_id,
              status = @status,
              config_json = @config_json,
              updated_at = SYSUTCDATETIME()
          WHERE site_integration_id = @site_integration_id;

          SELECT TOP 1 *
          FROM arion.site_integrations
          WHERE site_integration_id = @site_integration_id;
        `);
      return res.status(200).json({ integration: mapIntegrationRow(result.recordset[0]) });
    }

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("provider_code", sql.VarChar(50), providerCode)
      .input("integration_account_id", sql.UniqueIdentifier, integrationAccountId)
      .input("status", sql.VarChar(50), status)
      .input("config_json", sql.NVarChar(sql.MAX), configJson)
      .query(`
        DECLARE @new TABLE (site_integration_id uniqueidentifier);
        INSERT INTO arion.site_integrations (
          tenant_id,
          site_id,
          provider_code,
          integration_account_id,
          status,
          config_json
        )
        OUTPUT INSERTED.site_integration_id INTO @new(site_integration_id)
        VALUES (
          @tenant_id,
          @site_id,
          @provider_code,
          @integration_account_id,
          @status,
          @config_json
        );

        SELECT TOP 1 *
        FROM arion.site_integrations
        WHERE site_integration_id = (SELECT TOP 1 site_integration_id FROM @new);
      `);

    return res.status(201).json({ integration: mapIntegrationRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.integrations.put] error:", err);
    return res.status(500).json({ error: "Failed to upsert integration", details: err.message });
  }
});

router.get("/sites/:siteId/requests", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT *
        FROM arion.site_requests
        WHERE tenant_id = @tenant_id AND site_id = @site_id
        ORDER BY requested_at DESC;
      `);

    return res.status(200).json({ site: mapSiteRow(site), requests: result.recordset.map(mapRequestRow) });
  } catch (err) {
    console.error("[arion.requests.get] error:", err);
    return res.status(500).json({ error: "Failed to load site requests", details: err.message });
  }
});

router.post("/sites/:siteId/requests", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.params.siteId;
    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const requestType = cleanString(req.body?.requestType)?.toUpperCase() || "SUPPORT";
    const notes = cleanString(req.body?.notes);
    const requestedByEmail = cleanString(req.body?.requestedByEmail) || getEmailFromClaims(req.auth) || req.platformUser?.email || null;
    const isTest = toBoolean(req.body?.isTest, false);

    if (!notes) {
      return res.status(400).json({ error: "notes is required." });
    }

    const result = await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("request_type", sql.VarChar(50), requestType)
      .input("request_status", sql.VarChar(50), "OPEN")
      .input("requested_by_email", sql.NVarChar(320), requestedByEmail)
      .input("notes", sql.NVarChar(2000), notes)
      .input("is_test", sql.Bit, isTest)
      .query(`
        DECLARE @new TABLE (site_request_id uniqueidentifier);
        INSERT INTO arion.site_requests (
          tenant_id,
          site_id,
          request_type,
          request_status,
          requested_by_email,
          notes,
          is_test
        )
        OUTPUT INSERTED.site_request_id INTO @new(site_request_id)
        VALUES (
          @tenant_id,
          @site_id,
          @request_type,
          @request_status,
          @requested_by_email,
          @notes,
          @is_test
        );

        SELECT TOP 1 *
        FROM arion.site_requests
        WHERE site_request_id = (SELECT TOP 1 site_request_id FROM @new);
      `);

    return res.status(201).json({ request: mapRequestRow(result.recordset[0]) });
  } catch (err) {
    console.error("[arion.requests.create] error:", err);
    return res.status(500).json({ error: "Failed to create site request", details: err.message });
  }
});

router.post("/events", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const tenantId = req.tenant.tenantId;
    const siteId = req.body?.siteId;
    if (!siteId) {
      return res.status(400).json({ error: "siteId is required." });
    }

    const site = await loadSiteOr404(pool, tenantId, siteId, res);
    if (!site) return;

    const eventType = cleanString(req.body?.eventType)?.toUpperCase();
    if (!eventType) {
      return res.status(400).json({ error: "eventType is required." });
    }

    await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("event_type", sql.VarChar(100), eventType)
      .input("event_status", sql.VarChar(50), cleanString(req.body?.eventStatus)?.toUpperCase() || "INFO")
      .input("message", sql.NVarChar(2000), cleanString(req.body?.message))
      .input("details_json", sql.NVarChar(sql.MAX), req.body?.details ? JSON.stringify(req.body.details) : null)
      .input("job_key", sql.NVarChar(200), cleanString(req.body?.jobKey))
      .input("is_test", sql.Bit, toBoolean(req.body?.isTest, false))
      .query(`
        INSERT INTO arion.site_events (
          tenant_id,
          site_id,
          event_type,
          event_status,
          message,
          details_json,
          job_key,
          is_test
        )
        VALUES (
          @tenant_id,
          @site_id,
          @event_type,
          @event_status,
          @message,
          @details_json,
          @job_key,
          @is_test
        );
      `);

    return res.status(201).json({ ok: true, siteId, eventType });
  } catch (err) {
    console.error("[arion.events.create] error:", err);
    return res.status(500).json({ error: "Failed to create site event", details: err.message });
  }
});

export default router;
