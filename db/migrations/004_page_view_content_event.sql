/*
  Migration 004 - Tables for IA Plugin data pipeline
  Creates: arion.site_page_view, arion.site_content_event
  Safe to re-run (IF NOT EXISTS guarded)
*/

-- Page view tracking (from ARGUS beacon)
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_page_view') AND type = 'U')
CREATE TABLE arion.site_page_view (
  view_id       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  site_id       UNIQUEIDENTIFIER NOT NULL,
  page_url      NVARCHAR(1000)   NOT NULL,
  referrer      NVARCHAR(1000)   NULL,
  scroll_depth  INT              NULL,
  time_on_page  INT              NULL,
  screen_width  INT              NULL,
  created_at    DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_site_page_view PRIMARY KEY (view_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_view_site_date')
  CREATE NONCLUSTERED INDEX IX_page_view_site_date ON arion.site_page_view (site_id, created_at DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_view_site_page')
  CREATE NONCLUSTERED INDEX IX_page_view_site_page ON arion.site_page_view (site_id, page_url);

-- Content events (post published, page published, post updated)
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.site_content_event') AND type = 'U')
CREATE TABLE arion.site_content_event (
  event_id     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID(),
  tenant_id    UNIQUEIDENTIFIER NOT NULL,
  site_id      UNIQUEIDENTIFIER NOT NULL,
  event_type   NVARCHAR(50)     NOT NULL,
  post_id      INT              NULL,
  post_type    NVARCHAR(30)     NULL,
  post_title   NVARCHAR(500)    NULL,
  post_url     NVARCHAR(1000)   NULL,
  payload      NVARCHAR(MAX)    NULL,
  created_at   DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT PK_arion_site_content_event PRIMARY KEY (event_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_event_site_date')
  CREATE NONCLUSTERED INDEX IX_content_event_site_date ON arion.site_content_event (site_id, created_at DESC);
