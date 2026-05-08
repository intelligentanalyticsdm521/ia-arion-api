-- Migration 017: Per-site integration setup status
-- Drives the dashboard's "Connections" panel — each row is a tier-eligible
-- integration that's either pending user action (OAuth) or pending auto setup.
-- Status transitions handled by integrationKickoff.js and downstream
-- processors that run the actual API calls.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'site_integration_status' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.site_integration_status (
    status_pk          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    tenant_id          UNIQUEIDENTIFIER  NOT NULL,
    site_id            UNIQUEIDENTIFIER  NOT NULL,
    integration_key    NVARCHAR(40)      NOT NULL,
                        -- ga4 | gsc | gbp | bing | seranking | apple_business_connect
    status             NVARCHAR(40)      NOT NULL,
                        -- pending | pending_user_oauth | pending_auto_setup |
                        -- in_progress | active | failed | skipped
    domain             NVARCHAR(253)     NULL,
    external_ref       NVARCHAR(200)     NULL,    -- e.g. GA4 property ID, SE Ranking project ID
    error_message      NVARCHAR(1000)    NULL,
    last_attempt_at    DATETIMEOFFSET    NULL,
    created_at         DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at         DATETIMEOFFSET    NULL,

    CONSTRAINT UQ_site_integration UNIQUE (tenant_id, site_id, integration_key)
  );

  CREATE INDEX IX_site_integration_status_status ON arion.site_integration_status(status);
  CREATE INDEX IX_site_integration_status_site ON arion.site_integration_status(site_id);
END;
