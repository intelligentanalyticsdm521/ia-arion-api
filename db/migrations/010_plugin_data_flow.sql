-- Migration 010: IA Plugin Data Flow
-- ARION Plugin Integration — April 2026
-- Prerequisite: migrations 001-009 applied
--
-- Tables created:
--   1. arion.site_provision_code      — one-time codes used by the plugin to
--                                       redeem credentials during setup
--   2. arion.site_plugin_snapshot     — daily aggregated plugin data per site
--   3. arion.site_plugin_inventory    — point-in-time plugin list snapshots
--   4. arion.site_security_event      — security event log (Wordfence attacks,
--                                       login failures, user role changes, etc)
--   5. arion.site_content_change      — content lifecycle events (publish,
--                                       update, delete) pushed by the plugin
--   6. arion.site_woo_order           — WooCommerce order events (pseudonymized)
--   7. arion.site_plugin_update_log   — audit trail of update actions
--
-- Column additions:
--   * arion.site: plugin_connected_at, plugin_last_status_at,
--                 plugin_version, plugin_status

--------------------------------------------------------------------------
-- Column additions on arion.site
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'plugin_connected_at' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD plugin_connected_at DATETIMEOFFSET NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'plugin_last_status_at' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD plugin_last_status_at DATETIMEOFFSET NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'plugin_version' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD plugin_version NVARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'plugin_status' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD plugin_status NVARCHAR(30) NULL;  -- connected|disconnected|token_invalid|unreachable
GO

--------------------------------------------------------------------------
-- Table 1: arion.site_provision_code
-- One-time codes issued by IA staff (or the onboarding function) so that a
-- plugin install on a WP site can redeem credentials without any manual
-- token shuffling. Code format: IAPV-XXXX-XXXX-XXXX (20 chars).
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_provision_code') AND type = 'U')
CREATE TABLE arion.site_provision_code (
  code_id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  site_id         UNIQUEIDENTIFIER NOT NULL,
  code_hash       NVARCHAR(64)     NOT NULL,      -- SHA-256 of raw code
  created_by      NVARCHAR(100)    NULL,          -- admin user id / email who issued
  created_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  expires_at      DATETIMEOFFSET   NOT NULL,      -- 7 days from issue by default
  redeemed_at     DATETIMEOFFSET   NULL,          -- NULL until claimed
  redeemed_from_url NVARCHAR(500)  NULL,          -- home_url() the plugin reported
  revoked_at      DATETIMEOFFSET   NULL,          -- admin can revoke before redeem
  revoked_reason  NVARCHAR(500)    NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_provision_code_hash')
CREATE UNIQUE INDEX UQ_provision_code_hash ON arion.site_provision_code (code_hash);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_provision_code_site')
CREATE INDEX IX_provision_code_site ON arion.site_provision_code (site_id, expires_at DESC);
GO

--------------------------------------------------------------------------
-- Table 2: arion.site_plugin_snapshot
-- Nightly aggregate per site. One row per (site_id, snapshot_date) — if the
-- same day runs twice, we overwrite. Stores JSON payload so we can add new
-- fields without schema changes.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_plugin_snapshot') AND type = 'U')
CREATE TABLE arion.site_plugin_snapshot (
  snapshot_id     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  site_id         UNIQUEIDENTIFIER NOT NULL,
  snapshot_date   DATE             NOT NULL,

  -- Quick-access scalars (the full data lives in payload_json)
  plugin_version          NVARCHAR(20)   NULL,
  wp_version              NVARCHAR(20)   NULL,
  php_version             NVARCHAR(20)   NULL,
  theme_name              NVARCHAR(200)  NULL,
  theme_version           NVARCHAR(40)   NULL,
  plugins_total           INT            NULL,
  plugins_active          INT            NULL,
  plugins_update_available INT           NULL,
  theme_update_available  BIT            NULL,
  core_update_available   BIT            NULL,

  -- Security highlights
  wordfence_active        BIT            NULL,
  wordfence_firewall_on   BIT            NULL,
  wordfence_last_scan_at  DATETIMEOFFSET NULL,
  wordfence_blocked_24h   INT            NULL,
  core_health_critical    INT            NULL,
  core_health_recommended INT            NULL,

  -- Performance highlights
  litespeed_active        BIT            NULL,
  litespeed_opt_score     INT            NULL,
  shortpixel_active       BIT            NULL,

  -- Content highlights
  posts_published         INT            NULL,
  pages_published         INT            NULL,
  media_count             INT            NULL,
  rm_avg_seo_score        DECIMAL(5,2)   NULL,
  rm_posts_missing_meta   INT            NULL,

  -- Full JSON payload for anything not promoted to a column
  payload_json            NVARCHAR(MAX)  NULL,

  captured_at             DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_plugin_snapshot_daily')
CREATE UNIQUE INDEX UQ_plugin_snapshot_daily ON arion.site_plugin_snapshot (site_id, snapshot_date DESC);
GO

--------------------------------------------------------------------------
-- Table 3: arion.site_plugin_inventory
-- Current snapshot of installed plugins per site. Overwritten on each pull.
-- Used for vulnerability cross-ref + "plugin is out of date" UI.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_plugin_inventory') AND type = 'U')
CREATE TABLE arion.site_plugin_inventory (
  inventory_id     BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  plugin_file      NVARCHAR(300)    NOT NULL,     -- e.g. "akismet/akismet.php"
  plugin_slug      NVARCHAR(200)    NULL,
  plugin_name      NVARCHAR(300)    NULL,
  current_version  NVARCHAR(40)     NULL,
  new_version      NVARCHAR(40)     NULL,
  update_available BIT              NOT NULL DEFAULT 0,
  is_active        BIT              NOT NULL DEFAULT 0,
  author           NVARCHAR(200)    NULL,
  captured_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_plugin_inventory_site')
CREATE INDEX IX_plugin_inventory_site ON arion.site_plugin_inventory (site_id, captured_at DESC);
GO

--------------------------------------------------------------------------
-- Table 4: arion.site_security_event
-- Pushed by plugin webhooks: wordfence.*, user.login_failed, plugin.deleted,
-- plugin.activated. Also populated by the hourly security puller from
-- Wordfence log data.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_security_event') AND type = 'U')
CREATE TABLE arion.site_security_event (
  event_id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  event_type       NVARCHAR(80)     NOT NULL,    -- 'wordfence.attack_blocked', 'plugin.activated', etc
  severity         NVARCHAR(20)     NOT NULL DEFAULT 'info',  -- info|warning|critical
  title            NVARCHAR(300)    NULL,
  detail_json      NVARCHAR(MAX)    NULL,
  source_ip        NVARCHAR(45)     NULL,
  occurred_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  received_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  ack_at           DATETIMEOFFSET   NULL,         -- admin can acknowledge
  ack_by           NVARCHAR(100)    NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_security_event_site_time')
CREATE INDEX IX_security_event_site_time ON arion.site_security_event (site_id, occurred_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_security_event_unack')
CREATE INDEX IX_security_event_unack ON arion.site_security_event (site_id, severity, occurred_at DESC)
  WHERE ack_at IS NULL;
GO

--------------------------------------------------------------------------
-- Table 5: arion.site_content_change
-- Pushed by plugin on post.published, post.updated, post.deleted,
-- page.published. Feeds IndexNow submissions + the "freshness" signal in
-- Content Intelligence.
--
-- Kept separate from site_page_change (Market Monitor crawler-driven content
-- diff detection) because source + schema differ.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_content_change') AND type = 'U')
CREATE TABLE arion.site_content_change (
  change_id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  post_id          BIGINT           NOT NULL,
  post_type        NVARCHAR(40)     NOT NULL,
  change_type      NVARCHAR(20)     NOT NULL,   -- published|updated|deleted
  post_url         NVARCHAR(2000)   NULL,
  post_title       NVARCHAR(500)    NULL,
  author_id        BIGINT           NULL,
  word_count       INT              NULL,
  categories_json  NVARCHAR(MAX)    NULL,
  tags_json        NVARCHAR(MAX)    NULL,
  indexnow_submitted_at DATETIMEOFFSET NULL,
  occurred_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  received_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_change_site_time')
CREATE INDEX IX_content_change_site_time ON arion.site_content_change (site_id, occurred_at DESC);
GO

--------------------------------------------------------------------------
-- Table 6: arion.site_woo_order
-- WooCommerce order events. PII pseudonymized — we hash customer email to
-- enable repeat-customer detection without storing raw PII.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_woo_order') AND type = 'U')
CREATE TABLE arion.site_woo_order (
  woo_order_id     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  source_order_id  NVARCHAR(50)     NOT NULL,    -- Woo's order ID
  order_status     NVARCHAR(40)     NOT NULL,    -- created|completed|refunded
  order_total      DECIMAL(18,2)    NULL,
  currency         NVARCHAR(10)     NULL,
  customer_email_hash NVARCHAR(64)  NULL,
  items_json       NVARCHAR(MAX)    NULL,
  occurred_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  received_at      DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_woo_order_site_time')
CREATE INDEX IX_woo_order_site_time ON arion.site_woo_order (site_id, occurred_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_woo_order_source')
CREATE UNIQUE INDEX UQ_woo_order_source ON arion.site_woo_order (site_id, source_order_id, order_status);
GO

--------------------------------------------------------------------------
-- Table 7: arion.site_plugin_update_log
-- Audit trail of plugin/theme/core update actions triggered through ARION.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_plugin_update_log') AND type = 'U')
CREATE TABLE arion.site_plugin_update_log (
  log_id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  update_type      NVARCHAR(20)     NOT NULL,   -- plugin|theme|core
  target           NVARCHAR(300)    NOT NULL,   -- plugin file, theme stylesheet, or 'core'
  previous_version NVARCHAR(40)     NULL,
  new_version      NVARCHAR(40)     NULL,
  status           NVARCHAR(20)     NOT NULL,   -- success|failure
  error_message    NVARCHAR(MAX)    NULL,
  triggered_by     NVARCHAR(200)    NULL,       -- user id / email
  triggered_at     DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  completed_at     DATETIMEOFFSET   NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_update_log_site_time')
CREATE INDEX IX_update_log_site_time ON arion.site_plugin_update_log (site_id, triggered_at DESC);
GO

PRINT 'Migration 010 applied: plugin data flow tables created.';
