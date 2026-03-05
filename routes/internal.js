import express from "express";
import sql from "mssql";
import { getServicesPool } from "../db/servicesPool.js";
import { cleanString } from "../lib/claims.js";
import { asNumber, toBoolean } from "../lib/validation.js";

const router = express.Router();

function requireIngestKey(req, res, next) {
  const expected = (process.env.ARION_INGEST_KEY || "").trim();
  const provided = (req.header("x-arion-ingest-key") || "").trim();

  if (!expected) {
    return res.status(500).json({ error: "ARION_INGEST_KEY is not configured." });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Invalid ingest key." });
  }

  return next();
}

async function loadSite(pool, siteId) {
  const result = await pool
    .request()
    .input("site_id", sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1 site_id, tenant_id
      FROM arion.sites
      WHERE site_id = @site_id;
    `);

  return result.recordset[0] || null;
}

router.use(requireIngestKey);

router.post("/sites/:siteId/health", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const siteId = req.params.siteId;
    const site = await loadSite(pool, siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const existing = await pool
      .request()
      .input("site_id", sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 site_health_id
        FROM arion.site_health
        WHERE site_id = @site_id
        ORDER BY updated_at DESC, created_at DESC;
      `);

    const payload = {
      wordpressVersion: cleanString(req.body?.wordpressVersion),
      phpVersion: cleanString(req.body?.phpVersion),
      pluginUpdatesAvailable: asNumber(req.body?.pluginUpdatesAvailable),
      themeUpdatesAvailable: asNumber(req.body?.themeUpdatesAvailable),
      sslStatus: cleanString(req.body?.sslStatus),
      siteStatus: cleanString(req.body?.siteStatus),
      formDeliveryStatus: cleanString(req.body?.formDeliveryStatus),
      performanceScore: asNumber(req.body?.performanceScore),
    };

    if (existing.recordset[0]?.site_health_id) {
      await pool
        .request()
        .input("site_health_id", sql.UniqueIdentifier, existing.recordset[0].site_health_id)
        .input("wordpress_version", sql.VarChar(50), payload.wordpressVersion)
        .input("php_version", sql.VarChar(50), payload.phpVersion)
        .input("plugin_updates_available", sql.Int, payload.pluginUpdatesAvailable)
        .input("theme_updates_available", sql.Int, payload.themeUpdatesAvailable)
        .input("ssl_status", sql.VarChar(50), payload.sslStatus)
        .input("site_status", sql.VarChar(50), payload.siteStatus)
        .input("form_delivery_status", sql.VarChar(50), payload.formDeliveryStatus)
        .input("performance_score", sql.Int, payload.performanceScore)
        .query(`
          UPDATE arion.site_health
          SET wordpress_version = @wordpress_version,
              php_version = @php_version,
              plugin_updates_available = @plugin_updates_available,
              theme_updates_available = @theme_updates_available,
              ssl_status = @ssl_status,
              site_status = @site_status,
              form_delivery_status = @form_delivery_status,
              performance_score = @performance_score,
              last_health_check_at = SYSUTCDATETIME(),
              last_form_test_at = CASE WHEN @form_delivery_status IS NULL THEN last_form_test_at ELSE SYSUTCDATETIME() END,
              last_perf_check_at = CASE WHEN @performance_score IS NULL THEN last_perf_check_at ELSE SYSUTCDATETIME() END,
              updated_at = SYSUTCDATETIME()
          WHERE site_health_id = @site_health_id;
        `);
    } else {
      await pool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
        .input("site_id", sql.UniqueIdentifier, siteId)
        .input("wordpress_version", sql.VarChar(50), payload.wordpressVersion)
        .input("php_version", sql.VarChar(50), payload.phpVersion)
        .input("plugin_updates_available", sql.Int, payload.pluginUpdatesAvailable)
        .input("theme_updates_available", sql.Int, payload.themeUpdatesAvailable)
        .input("ssl_status", sql.VarChar(50), payload.sslStatus)
        .input("site_status", sql.VarChar(50), payload.siteStatus)
        .input("form_delivery_status", sql.VarChar(50), payload.formDeliveryStatus)
        .input("performance_score", sql.Int, payload.performanceScore)
        .query(`
          INSERT INTO arion.site_health (
            tenant_id,
            site_id,
            wordpress_version,
            php_version,
            plugin_updates_available,
            theme_updates_available,
            ssl_status,
            site_status,
            last_health_check_at,
            form_delivery_status,
            last_form_test_at,
            performance_score,
            last_perf_check_at
          )
          VALUES (
            @tenant_id,
            @site_id,
            @wordpress_version,
            @php_version,
            @plugin_updates_available,
            @theme_updates_available,
            @ssl_status,
            @site_status,
            SYSUTCDATETIME(),
            @form_delivery_status,
            CASE WHEN @form_delivery_status IS NULL THEN NULL ELSE SYSUTCDATETIME() END,
            @performance_score,
            CASE WHEN @performance_score IS NULL THEN NULL ELSE SYSUTCDATETIME() END
          );
        `);
    }

    return res.status(200).json({ ok: true, siteId, updatedAtUtc: new Date().toISOString() });
  } catch (err) {
    console.error("[internal.health] error:", err);
    return res.status(500).json({ error: "Failed to upsert site health", details: err.message });
  }
});

router.post("/sites/:siteId/plugins", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const siteId = req.params.siteId;
    const site = await loadSite(pool, siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const plugins = Array.isArray(req.body?.plugins) ? req.body.plugins : [];

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("site_id", sql.UniqueIdentifier, siteId)
        .query(`DELETE FROM arion.site_plugins WHERE site_id = @site_id;`);

      for (const plugin of plugins) {
        await new sql.Request(tx)
          .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
          .input("site_id", sql.UniqueIdentifier, siteId)
          .input("plugin_key", sql.VarChar(200), cleanString(plugin?.pluginKey) || cleanString(plugin?.plugin_key))
          .input("plugin_name", sql.NVarChar(200), cleanString(plugin?.pluginName) || cleanString(plugin?.plugin_name))
          .input("plugin_version", sql.VarChar(50), cleanString(plugin?.pluginVersion) || cleanString(plugin?.plugin_version))
          .input("is_required", sql.Bit, toBoolean(plugin?.isRequired ?? plugin?.is_required, false))
          .input("is_active", sql.Bit, toBoolean(plugin?.isActive ?? plugin?.is_active, true))
          .query(`
            INSERT INTO arion.site_plugins (
              tenant_id,
              site_id,
              plugin_key,
              plugin_name,
              plugin_version,
              is_required,
              is_active,
              last_checked_at
            )
            VALUES (
              @tenant_id,
              @site_id,
              @plugin_key,
              @plugin_name,
              @plugin_version,
              @is_required,
              @is_active,
              SYSUTCDATETIME()
            );
          `);
      }

      await tx.commit();
    } catch (innerErr) {
      await tx.rollback();
      throw innerErr;
    }

    return res.status(200).json({ ok: true, siteId, pluginCount: plugins.length, updatedAtUtc: new Date().toISOString() });
  } catch (err) {
    console.error("[internal.plugins] error:", err);
    return res.status(500).json({ error: "Failed to replace site plugins", details: err.message });
  }
});

router.post("/sites/:siteId/events", async (req, res) => {
  try {
    const pool = await getServicesPool();
    const siteId = req.params.siteId;
    const site = await loadSite(pool, siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const eventType = cleanString(req.body?.eventType) || cleanString(req.body?.event_type);
    if (!eventType) {
      return res.status(400).json({ error: "eventType is required." });
    }

    await pool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
      .input("site_id", sql.UniqueIdentifier, siteId)
      .input("event_type", sql.VarChar(100), eventType)
      .input("event_status", sql.VarChar(50), cleanString(req.body?.eventStatus) || cleanString(req.body?.event_status) || "INFO")
      .input("message", sql.NVarChar(2000), cleanString(req.body?.message))
      .input("details_json", sql.NVarChar(sql.MAX), req.body?.details ? JSON.stringify(req.body.details) : (typeof req.body?.detailsJson === "string" ? req.body.detailsJson : null))
      .input("job_key", sql.NVarChar(200), cleanString(req.body?.jobKey) || cleanString(req.body?.job_key))
      .input("is_test", sql.Bit, toBoolean(req.body?.isTest ?? req.body?.is_test, false))
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
    console.error("[internal.events] error:", err);
    return res.status(500).json({ error: "Failed to insert site event", details: err.message });
  }
});

export default router;
