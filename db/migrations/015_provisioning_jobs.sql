-- Migration 015: Provisioning job lifecycle
-- Tracks each Playwright-worker job from queued → running → succeeded/failed,
-- including phase-by-phase progress callbacks for live UI updates.
--
-- Adds:
--   - arion.provisioning_job table
--   - arion.signup_session.domain_json column (the resolved domain decision)
--   - arion.signup_session.provisioning_job_id column (latest active job)

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'provisioning_job' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.provisioning_job (
    job_id              UNIQUEIDENTIFIER  NOT NULL PRIMARY KEY,
    tenant_id           UNIQUEIDENTIFIER  NOT NULL,
    site_id             UNIQUEIDENTIFIER  NOT NULL,
    signup_session_pk   INT               NULL,    -- FK to signup_session.session_pk

    state               NVARCHAR(40)      NOT NULL DEFAULT 'queued',
                        -- queued | dns_verifying | dispatched | started | wp_login |
                        -- ai_builder_prompt | ai_builder_confirm | kodee_skip |
                        -- ai_builder_finalize | plugin_deploy | auto_redeem_trigger |
                        -- bootstrap_running | ready | ready_partial | failed
    progress_percent    INT               NOT NULL DEFAULT 0,

    -- Inputs the worker needs (snapshot at job creation time so retries are deterministic)
    payload_json        NVARCHAR(MAX)     NOT NULL,    -- { domain, prompt, brandName, wpAdminUrl, wpUser, wpPass, websiteId, provisionCode }

    -- Results / observability
    last_progress_at    DATETIMEOFFSET    NULL,
    last_message        NVARCHAR(500)     NULL,
    last_error          NVARCHAR(2000)    NULL,
    last_screenshot_b64 NVARCHAR(MAX)     NULL,        -- truncated to ~200KB by handler

    attempts            INT               NOT NULL DEFAULT 0,
    started_at          DATETIMEOFFSET    NULL,
    finished_at         DATETIMEOFFSET    NULL,

    created_at          DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at          DATETIMEOFFSET    NULL
  );

  CREATE INDEX IX_provisioning_job_site   ON arion.provisioning_job(site_id);
  CREATE INDEX IX_provisioning_job_state  ON arion.provisioning_job(state);
  CREATE INDEX IX_provisioning_job_tenant ON arion.provisioning_job(tenant_id);
END;

-- ---------------------------------------------------------------------------
-- arion.signup_session additions
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'domain_json' AND Object_ID = Object_ID('arion.signup_session'))
  ALTER TABLE arion.signup_session ADD domain_json NVARCHAR(2000) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'provisioning_job_id' AND Object_ID = Object_ID('arion.signup_session'))
  ALTER TABLE arion.signup_session ADD provisioning_job_id UNIQUEIDENTIFIER NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'submitted_at' AND Object_ID = Object_ID('arion.signup_session'))
  ALTER TABLE arion.signup_session ADD submitted_at DATETIMEOFFSET NULL;
