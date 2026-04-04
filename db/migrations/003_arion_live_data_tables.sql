/*
  Migration 003 - Tables for live data integration
  Target: iadm_services on sql-iadm-prod-cus.database.windows.net
  Safe to re-run (all IF NOT EXISTS guarded)

  Creates: arion.gbp_profile, arion.gsc_data, arion.se_ranking_summary
  Updates: IA tenant site to business tier + SEO authority addon
*/

-- 1. arion.gbp_profile — Google Business Profile data
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.gbp_profile') AND type = 'U')
CREATE TABLE arion.gbp_profile (
  profile_id       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  tenant_id        UNIQUEIDENTIFIER NOT NULL,
  site_id          UNIQUEIDENTIFIER NOT NULL,
  business_name    NVARCHAR(200)    NULL,
  description      NVARCHAR(MAX)    NULL,
  phone            NVARCHAR(30)     NULL,
  website          NVARCHAR(500)    NULL,
  address          NVARCHAR(MAX)    NULL,
  categories       NVARCHAR(MAX)    NULL,
  hours            NVARCHAR(MAX)    NULL,
  photo_count      INT              NULL DEFAULT 0,
  review_count     INT              NULL DEFAULT 0,
  avg_rating       DECIMAL(3,2)     NULL,
  completeness_pct INT              NULL,
  last_synced_at   DATETIMEOFFSET   NULL,
  created_at       DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at       DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_gbp_profile PRIMARY KEY (profile_id),
  CONSTRAINT CK_gbp_profile_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
  CONSTRAINT UQ_gbp_profile_tenant_site UNIQUE (tenant_id, site_id)
);

-- 2. arion.gsc_data — Google Search Console aggregated data
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.gsc_data') AND type = 'U')
CREATE TABLE arion.gsc_data (
  gsc_id       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  tenant_id    UNIQUEIDENTIFIER NOT NULL,
  site_id      UNIQUEIDENTIFIER NOT NULL,
  report_date  DATE             NOT NULL,
  query        NVARCHAR(500)    NULL,
  page         NVARCHAR(1000)   NULL,
  device       NVARCHAR(20)     NULL,
  country      NVARCHAR(10)     NULL,
  clicks       INT              NULL DEFAULT 0,
  impressions  INT              NULL DEFAULT 0,
  ctr          DECIMAL(8,6)     NULL,
  position     DECIMAL(8,2)     NULL,
  fetched_at   DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_gsc_data PRIMARY KEY (gsc_id),
  CONSTRAINT CK_gsc_data_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_gsc_data_tenant_site_date')
  CREATE NONCLUSTERED INDEX IX_gsc_data_tenant_site_date ON arion.gsc_data (tenant_id, site_id, report_date DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_gsc_data_tenant_site_query')
  CREATE NONCLUSTERED INDEX IX_gsc_data_tenant_site_query ON arion.gsc_data (tenant_id, site_id, query) WHERE query IS NOT NULL;

-- 3. arion.se_ranking_summary — SE Ranking snapshot data
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.se_ranking_summary') AND type = 'U')
CREATE TABLE arion.se_ranking_summary (
  summary_id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  tenant_id           UNIQUEIDENTIFIER NOT NULL,
  site_id             UNIQUEIDENTIFIER NOT NULL,
  visibility_score    DECIMAL(8,2)     NULL,
  audit_score         INT              NULL,
  tracked_keywords    INT              NULL,
  tracked_competitors INT              NULL,
  tracked_models      INT              NULL,
  critical_issues     INT              NULL,
  warning_issues      INT              NULL,
  backlink_count      INT              NULL,
  domain_authority    DECIMAL(5,2)     NULL,
  fetched_at          DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_se_ranking_summary PRIMARY KEY (summary_id),
  CONSTRAINT CK_se_ranking_summary_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_se_ranking_summary_tenant_site')
  CREATE NONCLUSTERED INDEX IX_se_ranking_summary_tenant_site ON arion.se_ranking_summary (tenant_id, site_id, fetched_at DESC);

-- 4. Update Intelligent Analytics tenant site to business tier + SEO authority
UPDATE arion.site
SET arion_tier = 'business',
    seo_addon_tier = 'authority',
    updated_at = SYSDATETIMEOFFSET()
WHERE tenant_id = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';
