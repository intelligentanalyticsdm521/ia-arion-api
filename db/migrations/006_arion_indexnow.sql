-- Migration 006: IndexNow key storage + submission log
-- ARION Search Indexing — April 2026
-- Prerequisite: migrations 001-005 applied

-- arion.site: IndexNow columns
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'indexnow_key' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD indexnow_key NVARCHAR(64) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'indexnow_generated_at' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD indexnow_generated_at DATETIME2 NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'indexnow_verified_at' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD indexnow_verified_at DATETIME2 NULL;

-- arion.indexnow_submission: log of every IndexNow submission attempt per site
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.indexnow_submission') AND type = 'U')
CREATE TABLE arion.indexnow_submission (
  submission_id   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  tenant_id       UNIQUEIDENTIFIER NOT NULL,
  site_id         UNIQUEIDENTIFIER NOT NULL,
  submitted_url   NVARCHAR(500)    NOT NULL,
  submitted_at    DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  status          NVARCHAR(20)     NOT NULL,    -- 'accepted' | 'rejected' | 'error' | 'no_key'
  response_code   INT              NULL,
  response_body   NVARCHAR(1000)   NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_indexnow_submission_site_date')
CREATE INDEX IX_indexnow_submission_site_date ON arion.indexnow_submission (site_id, submitted_at DESC);
