-- 067_site_audit.sql
--
-- The website audit tool: a generic "check any website" service that an agency
-- calls from its chat workflow as a CUSTOM ACTION (contract
-- CONTRACT_ARGUS_CHAT_PLAYBOOKS_2026-10-07.md §A.3 / §E).
--
-- NOTHING HERE BELONGS TO ONE BUSINESS. A caller is any agency that registered
-- the tool (scripts/register-audit-caller.mjs); its signing secret is stored
-- encrypted under AUDIT_CALLER_KEY, never in clear. A run is one audit of one
-- URL for one caller; the report's branding is whatever the signed request
-- carried, so the same rows serve every agency.
--
--   arion.site_audit_caller  who may call the tool, and the secret both sides sign with
--   arion.site_audit_run     one audit: status, score, plain findings, the PDF's
--                            private blob path, and the HASHES of the two link keys
--
-- Number 067 follows 066 (site_page_draft). Idempotent. Additive — safe to
-- pre-apply before the code push (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

IF OBJECT_ID('arion.site_audit_caller','U') IS NULL
BEGIN
  CREATE TABLE arion.site_audit_caller (
    caller_id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_site_audit_caller PRIMARY KEY CONSTRAINT DF_sac_id DEFAULT NEWID(),
    key_id             NVARCHAR(40)     NOT NULL,          -- the wfk_... key the caller sends as X-Workflow-Key
    label              NVARCHAR(200)    NOT NULL,          -- e.g. the agency's name, typed by whoever registers it
    owner_tenant_id    UNIQUEIDENTIFIER NOT NULL,          -- the business allowed to read these runs (GET /arion/audit/runs)
    secret_iv          NVARCHAR(48)     NOT NULL,
    secret_tag         NVARCHAR(48)     NOT NULL,
    secret_ciphertext  NVARCHAR(MAX)    NOT NULL,          -- AES-256-GCM under AUDIT_CALLER_KEY (never plaintext)
    status             NVARCHAR(12)     NOT NULL CONSTRAINT DF_sac_status DEFAULT 'active',
    daily_limit        INT              NOT NULL CONSTRAINT DF_sac_limit DEFAULT 50,
    created_at         DATETIME2        NOT NULL CONSTRAINT DF_sac_created DEFAULT SYSUTCDATETIME(),
    created_by         NVARCHAR(200)    NULL
  );
  CREATE UNIQUE INDEX UX_site_audit_caller_key ON arion.site_audit_caller (key_id);
END
GO

IF OBJECT_ID('arion.site_audit_run','U') IS NULL
BEGIN
  CREATE TABLE arion.site_audit_run (
    run_id                  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_site_audit_run PRIMARY KEY CONSTRAINT DF_sar_id DEFAULT NEWID(),
    caller_id               UNIQUEIDENTIFIER NOT NULL,
    external_run_id         NVARCHAR(80)     NOT NULL,     -- the caller's run id
    url                     NVARCHAR(1000)   NOT NULL,
    url_key                 NVARCHAR(300)    NOT NULL,     -- lower(host)+path without trailing slash
    audit_day               DATE             NOT NULL,     -- UTC day: one audit per url_key per caller per day
    status                  NVARCHAR(16)     NOT NULL,     -- queued | running | done | failed | callback_failed
    score                   INT              NULL,
    summary_plain           NVARCHAR(1000)   NULL,
    findings_json           NVARCHAR(MAX)    NULL,
    psi_json                NVARCHAR(MAX)    NULL,
    crawl_json              NVARCHAR(MAX)    NULL,
    blob_path               NVARCHAR(400)    NULL,         -- site-audits/<caller_id>/<run_id>/website-audit.pdf
    visitor_key_hash        CHAR(64)         NULL,         -- sha256 of the visitor link key
    owner_key_hash          CHAR(64)         NULL,         -- sha256 of the lead's link key
    visitor_link_expires_at DATETIME2        NULL,         -- created + 30 days
    callback_url            NVARCHAR(1000)   NOT NULL,
    callback_attempts       INT              NOT NULL CONSTRAINT DF_sar_cb DEFAULT 0,
    callback_last_error     NVARCHAR(300)    NULL,
    error_plain             NVARCHAR(500)    NULL,
    business_json           NVARCHAR(MAX)    NULL,         -- the branding block received (for re-render)
    visitor_json            NVARCHAR(MAX)    NULL,
    created_at              DATETIME2        NOT NULL CONSTRAINT DF_sar_created DEFAULT SYSUTCDATETIME(),
    started_at              DATETIME2        NULL,
    finished_at             DATETIME2        NULL
  );
  CREATE UNIQUE INDEX UX_site_audit_run_ext ON arion.site_audit_run (caller_id, external_run_id);
  CREATE INDEX IX_site_audit_run_day ON arion.site_audit_run (caller_id, url_key, audit_day);
END
GO
