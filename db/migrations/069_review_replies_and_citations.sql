-- 069_review_replies_and_citations.sql
--
-- ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1_2026-10-08 §A.2).
--
--   arion.gbp_reply_run     one row per Google-review-reply tick per business,
--                           written first and closed on every exit path (AC7)
--   arion.gbp_reply_draft   one row per reply the web person wrote. A reply now
--                           WAITS for the owner unless the job is Automatic and
--                           the review is at or above the owner's star line;
--                           a review of 3 stars or fewer always waits.
--   arion.content_agent_output / content_agent_run_log: which job wrote it,
--                           which playbook version ran, which Brief version it
--                           was written from, and the social hand-off.
--   argus.governance_agent_registration: the review-reply runs and held
--                           replies join the governance index and approvals
--                           count (a data row; the registry validates every
--                           identifier before it is used).
--
-- NOTHING HERE BELONGS TO ONE BUSINESS. Idempotent and additive: safe to
-- pre-apply before the code push (feedback_migrations_before_code_push). The
-- old switch columns are NOT dropped here; see db/migrations/later/070.
--
-- TARGET DB: iadm_services.

IF OBJECT_ID('arion.gbp_reply_run','U') IS NULL
BEGIN
  CREATE TABLE arion.gbp_reply_run (
    run_id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_gbp_reply_run PRIMARY KEY CONSTRAINT DF_gbp_reply_run_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NULL,
    trigger_source   NVARCHAR(20)     NOT NULL,   -- timer | manual
    status           NVARCHAR(20)     NOT NULL,   -- running | completed | failed | skipped
    outcome          NVARCHAR(40)     NULL,       -- worked | nothing_due | blocked | failed
    reviews_seen     INT              NULL,
    drafted          INT              NULL,
    held             INT              NULL,
    posted           INT              NULL,
    playbook_version INT              NULL,
    notes_json       NVARCHAR(MAX)    NULL,       -- plain sentences: why it skipped what it skipped
    cost_usd         DECIMAL(10,6)    NULL,
    error_plain      NVARCHAR(500)    NULL,
    started_at       DATETIMEOFFSET   NOT NULL CONSTRAINT DF_gbp_reply_run_started DEFAULT SYSDATETIMEOFFSET(),
    finished_at      DATETIMEOFFSET   NULL,
    CONSTRAINT CK_gbp_reply_run_status CHECK (status IN ('running','completed','failed','skipped'))
  );
  CREATE INDEX IX_gbp_reply_run_tenant ON arion.gbp_reply_run (tenant_id, started_at DESC);
  PRINT '  + arion.gbp_reply_run';
END
ELSE
  PRINT '  = arion.gbp_reply_run already present';
GO

IF OBJECT_ID('arion.gbp_reply_draft','U') IS NULL
BEGIN
  CREATE TABLE arion.gbp_reply_draft (
    draft_id         UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_gbp_reply_draft PRIMARY KEY CONSTRAINT DF_gbp_reply_draft_id DEFAULT NEWID(),
    run_id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_gbp_reply_draft_run REFERENCES arion.gbp_reply_run (run_id),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,
    gbp_review_id    NVARCHAR(200)    NOT NULL,   -- Google's id (reviews[].reviewId)
    reviewer_name    NVARCHAR(200)    NULL,
    star_rating      TINYINT          NOT NULL,
    review_text      NVARCHAR(MAX)    NULL,
    reply_text       NVARCHAR(MAX)    NOT NULL,   -- what the IL wrote
    reply_final      NVARCHAR(MAX)    NULL,       -- what was posted
    status           NVARCHAR(12)     NOT NULL,   -- held | posted | skipped | stood_down | failed
    held_reason      NVARCHAR(40)     NULL,       -- low_star | send_me_first | check:<name> | not_automatic_stars
    held_words       NVARCHAR(300)    NULL,
    flags_json       NVARCHAR(MAX)    NULL,
    brief_cited_json NVARCHAR(MAX)    NULL,
    decided_by       NVARCHAR(256)    NULL,       -- a person, or "Approved in advance by {name} on {date}"
    decided_at       DATETIMEOFFSET   NULL,
    skip_reason      NVARCHAR(500)    NULL,
    post_error_plain NVARCHAR(500)    NULL,
    created_at       DATETIMEOFFSET   NOT NULL CONSTRAINT DF_gbp_reply_draft_created DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT CK_gbp_reply_draft_status CHECK (status IN ('held','posted','skipped','stood_down','failed'))
  );
  -- One reply per review, ever: a second tick can never answer a review twice.
  CREATE UNIQUE INDEX UX_gbp_reply_draft_review ON arion.gbp_reply_draft (site_id, gbp_review_id);
  CREATE INDEX IX_gbp_reply_draft_queue ON arion.gbp_reply_draft (tenant_id, status, created_at DESC);
  PRINT '  + arion.gbp_reply_draft';
END
ELSE
  PRINT '  = arion.gbp_reply_draft already present';
GO

-- The content agent: the job, the Brief version, the social hand-off.
IF COL_LENGTH('arion.content_agent_output','brief_cited_json') IS NULL
  ALTER TABLE arion.content_agent_output ADD brief_cited_json NVARCHAR(MAX) NULL;
GO
IF COL_LENGTH('arion.content_agent_output','job_key') IS NULL
  ALTER TABLE arion.content_agent_output ADD job_key NVARCHAR(80) NULL;
GO
IF COL_LENGTH('arion.content_agent_output','scheduled_social_post_id') IS NULL
  ALTER TABLE arion.content_agent_output ADD scheduled_social_post_id NVARCHAR(100) NULL;
GO
IF COL_LENGTH('arion.content_agent_output','handoff_error_plain') IS NULL
  ALTER TABLE arion.content_agent_output ADD handoff_error_plain NVARCHAR(500) NULL;
GO
IF COL_LENGTH('arion.content_agent_output','approved_in_advance') IS NULL
  ALTER TABLE arion.content_agent_output ADD approved_in_advance BIT NOT NULL
    CONSTRAINT DF_content_agent_output_in_advance DEFAULT 0;
GO
IF COL_LENGTH('arion.content_agent_run_log','job_key') IS NULL
  ALTER TABLE arion.content_agent_run_log ADD job_key NVARCHAR(80) NULL;
GO
IF COL_LENGTH('arion.content_agent_run_log','playbook_version') IS NULL
  ALTER TABLE arion.content_agent_run_log ADD playbook_version INT NULL;
GO
PRINT '  + content agent: job_key, playbook_version, brief_cited_json, social hand-off columns';
GO

-- Governance registration (data row; oliver code unchanged).
IF OBJECT_ID('argus.governance_agent_registration','U') IS NOT NULL
BEGIN
  IF NOT EXISTS (SELECT 1 FROM argus.governance_agent_registration WHERE agent_key = N'arion_review_replies')
  BEGIN
    INSERT INTO argus.governance_agent_registration
      (agent_key, display_name, product, run_schema, run_table, run_id_column, tenant_column,
       status_column, cost_column, started_column, flags_column,
       queue_schema, queue_table, queue_id_column, queue_status_column, queue_pending_values)
    VALUES (N'arion_review_replies', N'ARION Google review replies', N'arion',
            N'arion', N'gbp_reply_run', N'run_id', N'tenant_id', N'status', N'cost_usd', N'started_at', N'notes_json',
            N'arion', N'gbp_reply_draft', N'draft_id', N'status', N'held');
    PRINT '  + arion_review_replies registration';
  END
  ELSE
    PRINT '  = arion_review_replies registration already present';
END
ELSE
  PRINT '  ! argus.governance_agent_registration not in this database; registration skipped';
GO
