-- Migration 005: PageSpeed snapshots + consulting inquiries + site columns
-- ARION Completion Build — April 2026
-- Prerequisite: migrations 001-004 applied

-- New table — arion.site_pagespeed_snapshot
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_pagespeed_snapshot') AND type = 'U')
CREATE TABLE arion.site_pagespeed_snapshot (
  snapshot_id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  tenant_id            UNIQUEIDENTIFIER NOT NULL,
  site_id              UNIQUEIDENTIFIER NOT NULL,
  run_date             DATE             NOT NULL,
  mobile_performance   INT              NULL,
  desktop_performance  INT              NULL,
  mobile_accessibility INT              NULL,
  desktop_accessibility INT             NULL,
  lcp_ms               INT              NULL,
  inp_ms               INT              NULL,
  cls_score            DECIMAL(6,4)     NULL,
  fcp_ms               INT              NULL,
  tbt_ms               INT              NULL,
  opportunities        NVARCHAR(MAX)    NULL,
  created_at           DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT UQ_pagespeed_site_date UNIQUE (tenant_id, site_id, run_date)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_pagespeed_site_date')
CREATE INDEX IX_pagespeed_site_date ON arion.site_pagespeed_snapshot (site_id, run_date DESC);

-- New table — arion.consulting_inquiry
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.consulting_inquiry') AND type = 'U')
CREATE TABLE arion.consulting_inquiry (
  inquiry_id    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  tenant_id     UNIQUEIDENTIFIER NOT NULL,
  site_id       UNIQUEIDENTIFIER NOT NULL,
  service_type  NVARCHAR(100)    NOT NULL,
  description   NVARCHAR(MAX)    NULL,
  contact_pref  NVARCHAR(30)     NULL,
  arion_tier    NVARCHAR(20)     NULL,
  seo_addon     NVARCHAR(20)     NULL,
  trigger_page  NVARCHAR(200)    NULL,
  created_at    DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

-- New columns on arion.site
-- WP Application Password (for Rank Math + WP Settings read/write)
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site' AND COLUMN_NAME='wp_app_password_ref')
  ALTER TABLE arion.site ADD wp_app_password_ref NVARCHAR(200) NULL;

-- SE Ranking audit ID for Site Audit endpoint
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site' AND COLUMN_NAME='se_ranking_audit_id')
  ALTER TABLE arion.site ADD se_ranking_audit_id NVARCHAR(50) NULL;

-- Bing connected flag
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site' AND COLUMN_NAME='bing_connected')
  ALTER TABLE arion.site ADD bing_connected BIT NOT NULL DEFAULT 0;
