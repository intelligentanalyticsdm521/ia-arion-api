-- 055_site_request.sql
-- Foundation (SCOPE_FOUNDATION_2026-09-04 §3A3) — ARION "request a change".
--
-- POST /arion/sites/:siteId/requests validated the body, minted a UUID and
-- returned it WITHOUT writing anything (routes/arion.js: "arion.site_request
-- table would need to exist"). Every client change request was discarded.
-- This is that table. Written by routes/arion.js (client) and read/updated by
-- routes/admin/siteRequests.js (founder queue, FOUNDER_ADMIN_TOKEN gate).
--
-- Number 055 reserved in WORK_REGISTRY_2026-09-04 (054 exists twice: main +
-- septa, different files — never reuse it).
--
-- Idempotent. Additive — safe to pre-apply.

PRINT '[055] Creating arion.site_request';
GO

IF OBJECT_ID('arion.site_request', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_request (
    site_request_id     UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_arion_site_request PRIMARY KEY,
    tenant_id           UNIQUEIDENTIFIER NOT NULL,
    site_id             UNIQUEIDENTIFIER NOT NULL,          -- soft ref -> arion.site
    request_type        NVARCHAR(40)     NOT NULL,          -- e.g. content_update (Portal WebsiteSupport)
    notes               NVARCHAR(MAX)    NULL,              -- the client's free text
    status              NVARCHAR(20)     NOT NULL CONSTRAINT DF_arion_site_request_status DEFAULT 'open',
    requested_by_email  NVARCHAR(320)    NULL,              -- caller identity from the JWT
    created_at          DATETIME2        NOT NULL CONSTRAINT DF_arion_site_request_created DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2        NOT NULL CONSTRAINT DF_arion_site_request_updated DEFAULT SYSUTCDATETIME(),
    resolved_at         DATETIME2        NULL,              -- stamped on done / declined
    resolution_notes    NVARCHAR(2000)   NULL,              -- founder's note back to the client
    CONSTRAINT CK_arion_site_request_status CHECK (status IN ('open', 'in_progress', 'done', 'declined'))
  );
  CREATE INDEX IX_arion_site_request_site ON arion.site_request (tenant_id, site_id, created_at DESC);
  CREATE INDEX IX_arion_site_request_status ON arion.site_request (status, created_at);
  PRINT '[055]   created arion.site_request';
END
ELSE
  PRINT '[055]   arion.site_request already exists';
GO

PRINT '[055] DONE.';
GO
