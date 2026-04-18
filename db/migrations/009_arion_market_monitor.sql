-- Migration 009: Market Monitor data tables
-- ARION Phase 3.5 Market Monitor backend — April 2026
-- Prerequisite: migrations 001-008 applied
--
-- Three data feeds:
--   1. Competitor Moves   — derived from daily position history (our own DB)
--   2. Backlink Watch     — weekly snapshot of referring domains from SE Ranking Data API
--   3. Page Changes       — our crawler + audit-diff detecting content changes
--
-- Plus a control table for job run bookkeeping.

--------------------------------------------------------------------------
-- Table 1: arion.se_ranking_position_history
-- Daily position capture per (site, engine, keyword) AND per (site, engine,
-- keyword, competitor_domain). Competitor rows have a non-null
-- competitor_domain. Your-own-site rows have NULL.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.se_ranking_position_history') AND type = 'U')
CREATE TABLE arion.se_ranking_position_history (
  history_id         BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  se_project_id      NVARCHAR(50)     NOT NULL,
  site_engine_id     NVARCHAR(50)     NOT NULL,
  keyword_id         NVARCHAR(50)     NOT NULL,
  keyword            NVARCHAR(500)    NULL,
  competitor_domain  NVARCHAR(300)    NULL,       -- NULL for your own site
  position           INT              NULL,       -- NULL or 0 = not ranking
  recorded_for       DATE             NOT NULL,   -- the date this reading represents
  recorded_at        DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_pos_history_site_date')
CREATE INDEX IX_pos_history_site_date ON arion.se_ranking_position_history (site_id, recorded_for DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_pos_history_keyword_engine_date')
CREATE INDEX IX_pos_history_keyword_engine_date ON arion.se_ranking_position_history (site_id, keyword_id, site_engine_id, recorded_for DESC)
  INCLUDE (position, competitor_domain);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_pos_history_daily')
CREATE UNIQUE INDEX UQ_pos_history_daily ON arion.se_ranking_position_history
  (tenant_id, site_id, site_engine_id, keyword_id, competitor_domain, recorded_for);
  -- ^ one row per (site, engine, keyword, competitor_domain) per day.
  --   NULL competitor_domain is treated as a distinct value by SQL Server when
  --   the filtered-index null-handling is left default. Acceptable here: every
  --   day will overwrite the own-site row's NULL slot via MERGE upsert.


--------------------------------------------------------------------------
-- Table 2: arion.se_ranking_backlink_snapshot
-- One row per (site, referring_domain) per snapshot_date. Tracks whether the
-- domain was 'active' (present this period), 'new' (appeared this period), or
-- 'lost' (was there last period, gone now). Anchor text + first/last seen.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.se_ranking_backlink_snapshot') AND type = 'U')
CREATE TABLE arion.se_ranking_backlink_snapshot (
  snapshot_id        BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  referring_domain   NVARCHAR(300)    NOT NULL,
  target_url         NVARCHAR(1000)   NULL,
  anchor_text        NVARCHAR(500)    NULL,
  domain_authority   INT              NULL,      -- 0-100 scale as reported
  link_status        NVARCHAR(20)     NOT NULL,  -- 'active' | 'new' | 'lost'
  first_seen         DATE             NULL,
  last_seen          DATE             NULL,
  snapshot_date      DATE             NOT NULL,
  recorded_at        DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_backlink_site_date')
CREATE INDEX IX_backlink_site_date ON arion.se_ranking_backlink_snapshot (site_id, snapshot_date DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_backlink_site_status_date')
CREATE INDEX IX_backlink_site_status_date ON arion.se_ranking_backlink_snapshot (site_id, link_status, snapshot_date DESC);


--------------------------------------------------------------------------
-- Table 3: arion.site_page_change
-- One row per detected page change. content_hash_prev vs content_hash_new
-- bounds the diff. excerpt_prev / excerpt_new hold short snippets so the UI
-- can render a "what changed" teaser without storing full HTML.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_page_change') AND type = 'U')
CREATE TABLE arion.site_page_change (
  change_id          BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  page_url           NVARCHAR(1000)   NOT NULL,
  page_type          NVARCHAR(40)     NOT NULL,  -- 'own_site' | 'competitor'
  competitor_domain  NVARCHAR(300)    NULL,
  content_hash_prev  NVARCHAR(64)     NULL,
  content_hash_new   NVARCHAR(64)     NOT NULL,
  change_magnitude   DECIMAL(5,2)     NULL,      -- 0.00 - 1.00 (% of content changed)
  excerpt_prev       NVARCHAR(1000)   NULL,
  excerpt_new        NVARCHAR(1000)   NULL,
  title_prev         NVARCHAR(500)    NULL,
  title_new          NVARCHAR(500)    NULL,
  detected_at        DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_change_site_detected')
CREATE INDEX IX_page_change_site_detected ON arion.site_page_change (site_id, detected_at DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_change_site_type')
CREATE INDEX IX_page_change_site_type ON arion.site_page_change (site_id, page_type, detected_at DESC);


--------------------------------------------------------------------------
-- Table 3b: arion.site_page_watch
-- The watchlist — which pages we crawl and hash on each cycle. Populated from
-- a) own-site priority pages (auto, top-10 by GSC clicks) and
-- b) competitor top-traffic pages (auto, from SE Ranking domain overview).
-- The watcher script reads from this table each run.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_page_watch') AND type = 'U')
CREATE TABLE arion.site_page_watch (
  watch_id           BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  page_url           NVARCHAR(1000)   NOT NULL,
  page_type          NVARCHAR(40)     NOT NULL,  -- 'own_site' | 'competitor'
  competitor_domain  NVARCHAR(300)    NULL,
  last_content_hash  NVARCHAR(64)     NULL,
  last_checked_at    DATETIMEOFFSET   NULL,
  last_title         NVARCHAR(500)    NULL,
  last_excerpt       NVARCHAR(1000)   NULL,
  enabled            BIT              NOT NULL DEFAULT 1,
  created_at         DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_page_watch_site_url')
CREATE UNIQUE INDEX UQ_page_watch_site_url ON arion.site_page_watch (site_id, page_url);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_watch_site_enabled')
CREATE INDEX IX_page_watch_site_enabled ON arion.site_page_watch (site_id, enabled, last_checked_at);


--------------------------------------------------------------------------
-- Table 4: arion.market_monitor_job_log
-- One row per (site, job_name) last-run marker. The scheduler queries this to
-- decide whether enough time has elapsed since the last successful run.
--------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.market_monitor_job_log') AND type = 'U')
CREATE TABLE arion.market_monitor_job_log (
  log_id             BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  job_name           NVARCHAR(60)     NOT NULL,   -- 'moves' | 'backlinks' | 'page_changes'
  status             NVARCHAR(20)     NOT NULL,   -- 'success' | 'error' | 'skipped'
  rows_processed     INT              NULL,
  error_message      NVARCHAR(2000)   NULL,
  started_at         DATETIMEOFFSET   NOT NULL,
  completed_at       DATETIMEOFFSET   NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_mm_job_log_site_job_started')
CREATE INDEX IX_mm_job_log_site_job_started ON arion.market_monitor_job_log (site_id, job_name, started_at DESC);
