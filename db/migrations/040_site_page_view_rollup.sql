-- 040 — arion.site_page_view_daily
-- Purpose: rollup of arion.site_page_view to daily grain for retention job
-- (G5-S5, RETENTION-001). The retention job aggregates raw hit rows into this
-- table, then prunes raw rows older than the retention window. Downstream
-- reporting reads from the daily rollup for long-range trends.
-- Note: site_id is part of the composite PK and therefore NOT NULL. All
-- rolled-up rows must have a non-null site_id; raw page-view rows without a
-- site_id are orphan data (pre-multi-tenant) and cannot be rolled up.
-- Date: 2026-06-30

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('arion.site_page_view_daily'))
    CREATE TABLE arion.site_page_view_daily (
      rollup_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_site_page_view_daily_id DEFAULT NEWSEQUENTIALID(),
      tenant_id UNIQUEIDENTIFIER NOT NULL,
      site_id UNIQUEIDENTIFIER NOT NULL,
      page_path NVARCHAR(500) NOT NULL,
      day_utc DATE NOT NULL,
      view_count INT NOT NULL CONSTRAINT DF_site_page_view_daily_view_count DEFAULT 0,
      unique_visitors INT NOT NULL CONSTRAINT DF_site_page_view_daily_unique_visitors DEFAULT 0,
      bot_view_count INT NOT NULL CONSTRAINT DF_site_page_view_daily_bot_view_count DEFAULT 0,
      rolled_up_at DATETIME2(3) NOT NULL CONSTRAINT DF_site_page_view_daily_rolled_up_at DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_site_page_view_daily PRIMARY KEY CLUSTERED (tenant_id, site_id, day_utc, page_path)
    );
GO

-- Rollback:
-- IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('arion.site_page_view_daily'))
--     DROP TABLE arion.site_page_view_daily;
-- GO
