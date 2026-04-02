/*
  Migration 002 - ARION v1.5 columns and tables
  Target: iadm_services on sql-iadm-prod-cus.database.windows.net
  Safe to re-run (all IF NOT EXISTS guarded)
*/

-- New columns on arion.site
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'site' AND COLUMN_NAME = 'wp_editor_username')
  ALTER TABLE arion.site ADD wp_editor_username NVARCHAR(100) NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'site' AND COLUMN_NAME = 'ga4_property_id')
  ALTER TABLE arion.site ADD ga4_property_id NVARCHAR(50) NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'site' AND COLUMN_NAME = 'se_ranking_project_id')
  ALTER TABLE arion.site ADD se_ranking_project_id NVARCHAR(50) NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'site' AND COLUMN_NAME = 'seo_addon_tier')
  ALTER TABLE arion.site ADD seo_addon_tier NVARCHAR(20) NULL;

-- New table: arion.site_access_log
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_access_log') AND type = 'U')
CREATE TABLE arion.site_access_log (
  log_id       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  tenant_id    UNIQUEIDENTIFIER NOT NULL,
  site_id      UNIQUEIDENTIFIER NOT NULL,
  user_id      NVARCHAR(200)    NULL,
  action       NVARCHAR(50)     NOT NULL,
  ip_address   NVARCHAR(45)     NULL,
  created_at   DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_site_access_log PRIMARY KEY (log_id),
  CONSTRAINT CK_arion_access_log_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_arion_access_log_tenant_site')
  CREATE NONCLUSTERED INDEX IX_arion_access_log_tenant_site ON arion.site_access_log (tenant_id, site_id, created_at DESC);
