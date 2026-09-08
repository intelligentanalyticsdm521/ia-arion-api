-- 063_content_agent.sql
--
-- The ARION Content & Social Agent — storage layer.
-- Task 1 of ARION_ContentSocialAgent_Scope v0.2, Section 31 Build Sequence.
--
-- WHAT THIS IS
--
-- The first ARGUS agent on the platform. It runs the content pipeline that is
-- currently a series of one-off chat sessions: keyword research, drafting,
-- image direction, scheduling. Everything it does is human-approved before it
-- publishes (scope 12.6), and every run is logged with cost, tokens and flags,
-- because this build's governance pattern is the template every later OLIVER /
-- SPARK / STELLA agent inherits.
--
-- Brandon 2026-08-23: "the agent is a product that we would sell to our clients
-- so it would go on their tenant when signed up." So nothing here is scoped to
-- one privileged tenant. tenant_id is simply whoever owns the run.
--
-- Brandon 2026-08-23: "it needs to learn about our clients and their style
-- (only the tenant they are currently assigned to)." The parenthetical is the
-- hard constraint and it is why content_agent_tenant_style is keyed by
-- tenant_id with a filtered unique index that permits exactly one active
-- profile per tenant. A client's voice is their commercial property; blending
-- it into another tenant's content would be a serious breach, so isolation is
-- enforced here in the schema rather than left to prompt discipline.
--
-- SIX TABLES
--
--   content_agent_run_log      one row per agent run — the audit spine
--   content_agent_output       one row per drafted content unit + its review outcome
--   content_agent_tenant_style the learned per-tenant voice/brand profile
--   content_agent_style_signal the evidence a profile is learned FROM
--   content_agent_code_proposal the propose-only code queue (scope 12.13)
--   content_keyword_candidate  the Keyword Tracker as a table, not a parsed docx
--
-- DELIBERATE DEVIATIONS FROM SCOPE 22.1, all logged in the doc's Section 37:
--
--   * cost_cents INT -> cost_usd DECIMAL(10,6). Acceptance criterion AC7 caps
--     the whole deployment at $10/month across ~30 content units, so per-unit
--     cost lands around $0.05. Integer cents cannot represent that without
--     rounding every row, and the aggregate is the thing being measured.
--     DECIMAL(10,6) matches lumen.ai_call_audit.cost_basis_usd exactly — the
--     platform's existing AI-cost precedent.
--
--   * UNIQUEIDENTIFIER primary keys rather than BIGINT IDENTITY. 43 of the 66
--     arion primary keys are uniqueidentifier; IDENTITY is reserved for the
--     append-only site_*_snapshot series. These are entity tables written by a
--     Function App that must be able to mint an id before the insert so a
--     retried run is idempotent rather than duplicated.
--
--   * The scope doc named arion.performance_snapshots as the precedent to
--     follow. That table does not exist in iadm_services. The real convention,
--     followed here, comes from the arion.site_*_snapshot family and
--     lumen.ai_call_audit: uniqueidentifier tenant scoping, _json suffix on
--     nvarchar(max) payloads, DATETIMEOFFSET event times under named DF_
--     constraints.
--
-- Additive only. No existing table is modified (scope 22.2).
--
-- RENUMBERED 053 -> 063 (2026-09-08). This file was written against a working
-- copy where 053 was free; on release/sept-a-2026 053 is
-- 053_site_tier_hygiene.sql and 055/059/061 are taken as well. 063 is
-- reserved for the Content Agent in overnight-report/WORK_REGISTRY_2026-09-04.md.
-- The dev database already holds these objects from the 2026-08-24 apply, which
-- is recorded in db.schema_migrations under the OLD filename; this file is
-- idempotent, so re-applying it under the new number is a no-op that fixes the
-- ledger rather than a second attempt at the DDL.
--
-- IDEMPOTENT PER _tools/IDEMPOTENCY.md: the table is guarded on OBJECT_ID and
-- every index on sys.indexes SEPARATELY. The original shape put the CREATE INDEX
-- statements INSIDE the table's IF-NULL block, so a table that existed with a
-- missing index could never gain it — the file would report success and change
-- nothing, which is the "reported success, stored nothing" shape this platform
-- keeps being bitten by. Each object now converges on its own.

-------------------------------------------------------------------------------
-- 1. content_agent_run_log — the audit spine
-------------------------------------------------------------------------------
-- Every run lands here whether it succeeded, failed or escalated (AC6). This
-- is the table that answers "what did the agent cost us this month" (AC7) and
-- "did anything ship unreviewed" (AC2), so it is written FIRST in a run and
-- updated on completion, never written only on success. The platform has a
-- documented recurring bug where an error is caught, swallowed, and reported
-- as success; a row that exists from the moment a run starts is the structural
-- defence against that.

IF OBJECT_ID('arion.content_agent_run_log', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_run_log (
    run_id           UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_run_log PRIMARY KEY
      CONSTRAINT DF_content_agent_run_log_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NULL,   -- null for runs not tied to one site

    agent_name       NVARCHAR(128)    NOT NULL,
    agent_version    NVARCHAR(40)     NULL,
    trigger_source   NVARCHAR(40)     NULL,   -- timer | manual | backfill

    -- pending set at insert; the run moves through running -> completed/failed/
    -- escalated. 'escalated' is a first-class terminal state, not a failure:
    -- Decision Rule 21.6 stopping a unit is the system working (AC2).
    status           NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_content_agent_run_log_status DEFAULT 'pending'
      CONSTRAINT CK_content_agent_run_log_status
        CHECK (status IN ('pending','running','completed','failed','escalated')),

    triggered_at     DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_run_log_trig DEFAULT SYSDATETIMEOFFSET(),
    completed_at     DATETIMEOFFSET   NULL,

    tokens_in        INT              NULL,
    tokens_out       INT              NULL,
    cost_usd         DECIMAL(10,6)    NULL,   -- see header: not cents
    model_version    NVARCHAR(128)    NULL,

    decision_rule_flags_json NVARCHAR(MAX) NULL,  -- [] when clean, never null on a completed run
    error_detail     NVARCHAR(MAX)    NULL,

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_run_log_cre DEFAULT SYSDATETIMEOFFSET()
  );
END
GO

-- "show me this tenant's recent runs" — the review-queue and run-log endpoints
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_run_log_tenant_time' AND object_id = OBJECT_ID('arion.content_agent_run_log'))
  CREATE INDEX IX_content_agent_run_log_tenant_time
    ON arion.content_agent_run_log (tenant_id, triggered_at DESC);
GO

-- "what is stuck or escalated right now" — the alerting path (30.2)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_run_log_status' AND object_id = OBJECT_ID('arion.content_agent_run_log'))
  CREATE INDEX IX_content_agent_run_log_status
    ON arion.content_agent_run_log (tenant_id, status, triggered_at DESC);
GO

-------------------------------------------------------------------------------
-- 2. content_agent_output — one drafted content unit
-------------------------------------------------------------------------------
-- AC3: when Brandon approves a draft, the approved (possibly EDITED) version is
-- what publishes. That is why body_markdown and body_markdown_final are separate
-- columns rather than one mutated field — edge case E2 requires the original be
-- retained for comparison, and it is also the raw material the style-learning
-- loop reads (a diff between what the agent wrote and what shipped is the single
-- most informative signal available).

IF OBJECT_ID('arion.content_agent_output', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_output (
    output_id        UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_output PRIMARY KEY
      CONSTRAINT DF_content_agent_output_id DEFAULT NEWID(),
    run_id           UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT FK_content_agent_output_run
        REFERENCES arion.content_agent_run_log (run_id),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NULL,

    content_type     NVARCHAR(40)     NOT NULL,  -- blog_post | social_carousel | social_post

    -- keyword rationale. User story 3: Brandon must see WHY a keyword was
    -- chosen, so the evidence is stored beside the draft, not recomputed later.
    primary_keyword  NVARCHAR(300)    NULL,
    keyword_volume   INT              NULL,
    keyword_kd       DECIMAL(6,2)     NULL,
    keyword_intent   NVARCHAR(40)     NULL,
    keyword_rationale NVARCHAR(MAX)   NULL,

    title            NVARCHAR(500)    NULL,
    body_markdown    NVARCHAR(MAX)    NULL,     -- what the agent produced
    body_markdown_final NVARCHAR(MAX) NULL,     -- what Brandon approved (E2)
    meta_description NVARCHAR(500)    NULL,
    url_slug         NVARCHAR(400)    NULL,
    cover_image_prompt NVARCHAR(MAX)  NULL,
    asset_uri        NVARCHAR(1000)   NULL,     -- rendered carousel PNG (Q2 pending)

    -- the style profile in force when this was drafted, so a regression in
    -- output quality can be traced to the profile version that caused it
    style_profile_id UNIQUEIDENTIFIER NULL,

    decision_rule_flags_json NVARCHAR(MAX) NULL,
    confidence_note  NVARCHAR(MAX)    NULL,

    review_status    NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_content_agent_output_rev DEFAULT 'pending'
      CONSTRAINT CK_content_agent_output_rev
        CHECK (review_status IN ('pending','approved','edited','rejected','escalated')),
    review_note      NVARCHAR(MAX)    NULL,
    reviewed_by      NVARCHAR(256)    NULL,
    approved_at      DATETIMEOFFSET   NULL,

    -- AC8: nothing reaches WordPress without an approval action, so a non-null
    -- published_at with a null approved_at is a contract violation by construction.
    published_at     DATETIMEOFFSET   NULL,
    wordpress_post_id BIGINT          NULL,

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_output_cre DEFAULT SYSDATETIMEOFFSET()
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_output_run' AND object_id = OBJECT_ID('arion.content_agent_output'))
  CREATE INDEX IX_content_agent_output_run
    ON arion.content_agent_output (run_id);
GO

-- the review queue: "what is pending for this tenant"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_output_queue' AND object_id = OBJECT_ID('arion.content_agent_output'))
  CREATE INDEX IX_content_agent_output_queue
    ON arion.content_agent_output (tenant_id, review_status, created_at DESC);
GO

-- AC5: the 90-day dedup check reads published slugs/keywords for this tenant
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_output_published' AND object_id = OBJECT_ID('arion.content_agent_output'))
  CREATE INDEX IX_content_agent_output_published
    ON arion.content_agent_output (tenant_id, published_at)
    WHERE published_at IS NOT NULL;
GO

-------------------------------------------------------------------------------
-- 3. content_agent_tenant_style — the learned voice/brand profile
-------------------------------------------------------------------------------
-- Scope 12.12. Versioned rather than mutated: a profile that starts producing
-- worse drafts must be revertible, and content_agent_output.style_profile_id
-- points at the exact version that drafted it.
--
-- The filtered unique index is the isolation guarantee in schema form — exactly
-- one active profile per tenant, so "load the active profile" cannot silently
-- return another tenant's row or two rows blended together.

IF OBJECT_ID('arion.content_agent_tenant_style', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_tenant_style (
    style_id         UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_tenant_style PRIMARY KEY
      CONSTRAINT DF_content_agent_tenant_style_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NULL,

    profile_version  INT              NOT NULL
      CONSTRAINT DF_content_agent_tenant_style_ver DEFAULT 1,

    voice_json       NVARCHAR(MAX)    NULL,  -- tone, register, person, rhythm
    vocabulary_json  NVARCHAR(MAX)    NULL,  -- preferred terms + banned terms
    formatting_json  NVARCHAR(MAX)    NULL,  -- heading style, list use, length
    brand_tokens_json NVARCHAR(MAX)   NULL,  -- colour + type tokens for imagery
    authority_json   NVARCHAR(MAX)    NULL,  -- claims this tenant may legitimately make

    -- how much evidence stands behind this profile. A profile with 3 signals
    -- should not be trusted like one with 300, and the drafting step reads
    -- confidence to decide how hard to lean on it.
    evidence_count   INT              NOT NULL
      CONSTRAINT DF_content_agent_tenant_style_ev DEFAULT 0,
    confidence       DECIMAL(5,4)     NULL,
    learned_through  DATETIMEOFFSET   NULL,   -- signals up to this point are baked in

    is_active        BIT              NOT NULL
      CONSTRAINT DF_content_agent_tenant_style_act DEFAULT 1,

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_tenant_style_cre DEFAULT SYSDATETIMEOFFSET(),
    updated_at       DATETIMEOFFSET   NULL
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_content_agent_tenant_style_ver' AND object_id = OBJECT_ID('arion.content_agent_tenant_style'))
  CREATE UNIQUE INDEX UX_content_agent_tenant_style_ver
    ON arion.content_agent_tenant_style (tenant_id, profile_version);
GO

-- THE isolation guard: one active profile per tenant, enforced by the engine
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_content_agent_tenant_style_active' AND object_id = OBJECT_ID('arion.content_agent_tenant_style'))
  CREATE UNIQUE INDEX UX_content_agent_tenant_style_active
    ON arion.content_agent_tenant_style (tenant_id)
    WHERE is_active = 1;
GO

-------------------------------------------------------------------------------
-- 4. content_agent_style_signal — the evidence
-------------------------------------------------------------------------------
-- Scope 12.11: "the learning loop is evidence-based and bounded, not a
-- fine-tune." This is that evidence. One row per observed review delta, so the
-- profile above is always reconstructible from primary records rather than
-- being an opaque blob that drifted.
--
-- This is the only table in the build whose value compounds: every week of
-- reviews makes the next week's drafts closer to what the client would have
-- written themselves.

IF OBJECT_ID('arion.content_agent_style_signal', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_style_signal (
    signal_id        UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_style_signal PRIMARY KEY
      CONSTRAINT DF_content_agent_style_signal_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    output_id        UNIQUEIDENTIFIER NULL
      CONSTRAINT FK_content_agent_style_signal_output
        REFERENCES arion.content_agent_output (output_id),

    signal_kind      NVARCHAR(30)     NOT NULL
      CONSTRAINT CK_content_agent_style_signal_kind
        CHECK (signal_kind IN ('approved_as_is','edited','rejected','performance')),

    field_name       NVARCHAR(80)     NULL,   -- title | body | meta | slug | caption
    before_text      NVARCHAR(MAX)    NULL,   -- what the agent wrote
    after_text       NVARCHAR(MAX)    NULL,   -- what actually shipped
    edit_distance    INT              NULL,
    reviewer_note    NVARCHAR(MAX)    NULL,

    -- for signal_kind='performance': the post's real outcome 30/90 days on,
    -- which is how the loop learns what RANKED, not merely what read well
    metric_json      NVARCHAR(MAX)    NULL,

    observed_at      DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_style_signal_obs DEFAULT SYSDATETIMEOFFSET(),
    consumed_at      DATETIMEOFFSET   NULL    -- when folded into a profile version
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_style_signal_tenant' AND object_id = OBJECT_ID('arion.content_agent_style_signal'))
  CREATE INDEX IX_content_agent_style_signal_tenant
    ON arion.content_agent_style_signal (tenant_id, observed_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_style_signal_output' AND object_id = OBJECT_ID('arion.content_agent_style_signal'))
  CREATE INDEX IX_content_agent_style_signal_output
    ON arion.content_agent_style_signal (output_id);
GO

-- "which signals have not been folded into a profile yet"
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_style_signal_unconsumed' AND object_id = OBJECT_ID('arion.content_agent_style_signal'))
  CREATE INDEX IX_content_agent_style_signal_unconsumed
    ON arion.content_agent_style_signal (tenant_id, observed_at)
    WHERE consumed_at IS NULL;
GO

-------------------------------------------------------------------------------
-- 5. content_agent_code_proposal — propose-only, never applied by the agent
-------------------------------------------------------------------------------
-- Scope 12.13. Brandon asked whether the agent could "write some internal code
-- as it learns from our intelligence layers if it can do it safely."
--
-- This table IS the safety mechanism. The agent writes a diff and a rationale
-- into a queue and stops. It cannot commit, push, merge, open a pull request,
-- apply a migration, deploy, or execute what it wrote — there is no code path
-- that reads diff_text and runs it, by design, and adding one would be a
-- deliberate act rather than an oversight.
--
-- applied_commit is written by a HUMAN after they have taken the proposal
-- through the ordinary session process. It is a record of what a person did,
-- never an instruction the agent can act on.

IF OBJECT_ID('arion.content_agent_code_proposal', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_code_proposal (
    proposal_id      UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_code_proposal PRIMARY KEY
      CONSTRAINT DF_content_agent_code_proposal_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    run_id           UNIQUEIDENTIFIER NULL
      CONSTRAINT FK_content_agent_code_proposal_run
        REFERENCES arion.content_agent_run_log (run_id),

    proposal_kind    NVARCHAR(60)     NOT NULL,  -- deep_config | quality_rule | heuristic | template
    target_repo      NVARCHAR(120)    NULL,
    target_path      NVARCHAR(1000)   NULL,

    diff_text        NVARCHAR(MAX)    NULL,   -- unified diff; NEVER executed
    rationale        NVARCHAR(MAX)    NULL,
    risk_note        NVARCHAR(MAX)    NULL,
    evidence_json    NVARCHAR(MAX)    NULL,   -- the run/signal ids that motivated it

    review_status    NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_content_agent_code_proposal_rev DEFAULT 'pending'
      CONSTRAINT CK_content_agent_code_proposal_rev
        CHECK (review_status IN ('pending','approved','rejected','applied')),
    reviewed_by      NVARCHAR(256)    NULL,
    reviewed_at      DATETIMEOFFSET   NULL,
    applied_commit   NVARCHAR(80)     NULL,   -- written by a human, post-hoc

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_agent_code_proposal_cre DEFAULT SYSDATETIMEOFFSET()
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_code_proposal_queue' AND object_id = OBJECT_ID('arion.content_agent_code_proposal'))
  CREATE INDEX IX_content_agent_code_proposal_queue
    ON arion.content_agent_code_proposal (review_status, created_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_agent_code_proposal_tenant' AND object_id = OBJECT_ID('arion.content_agent_code_proposal'))
  CREATE INDEX IX_content_agent_code_proposal_tenant
    ON arion.content_agent_code_proposal (tenant_id, created_at DESC);
GO

-------------------------------------------------------------------------------
-- 6. content_keyword_candidate — the Keyword Tracker, as data
-------------------------------------------------------------------------------
-- Open Question Q1 in the scope doc asks whether the IA Keyword Tracker stays a
-- docx the agent parses or becomes a table. This is the table, included ahead of
-- Brandon's answer because Q1 is targeted "Before Task 2" and Task 2 is next:
-- if he prefers the document-plus-sync route the table simply goes unused, at
-- zero cost, whereas its absence would block the task outright.
--
-- Parsing a Word document on every run is also failure mode F10 waiting to
-- happen — a silently changed heading and the agent runs on rules it cannot see
-- it misread.

IF OBJECT_ID('arion.content_keyword_candidate', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_keyword_candidate (
    candidate_id     UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_keyword_candidate PRIMARY KEY
      CONSTRAINT DF_content_keyword_candidate_id DEFAULT NEWID(),
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NULL,

    keyword          NVARCHAR(300)    NOT NULL,
    search_volume    INT              NULL,
    keyword_difficulty DECIMAL(6,2)   NULL,
    intent           NVARCHAR(40)     NULL,   -- informational | commercial | transactional | navigational
    source           NVARCHAR(60)     NULL,   -- se_ranking | backlog | manual | agent

    -- 'backlog' is what failure modes F1 and F6 fall back to: SE Ranking down,
    -- or the topic was already published in the last 90 days.
    status           NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_content_keyword_candidate_st DEFAULT 'candidate'
      CONSTRAINT CK_content_keyword_candidate_st
        CHECK (status IN ('candidate','backlog','in_progress','published','rejected')),

    -- edge case E4: research older than the staleness threshold gets re-pulled
    last_researched_at DATETIMEOFFSET NULL,
    published_output_id UNIQUEIDENTIFIER NULL
      CONSTRAINT FK_content_keyword_candidate_output
        REFERENCES arion.content_agent_output (output_id),

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_content_keyword_candidate_cre DEFAULT SYSDATETIMEOFFSET()
  );
END
GO

-- one row per keyword per tenant — the dedup guarantee (Decision Rule 21.1)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_content_keyword_candidate_kw' AND object_id = OBJECT_ID('arion.content_keyword_candidate'))
  CREATE UNIQUE INDEX UX_content_keyword_candidate_kw
    ON arion.content_keyword_candidate (tenant_id, keyword);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_content_keyword_candidate_status' AND object_id = OBJECT_ID('arion.content_keyword_candidate'))
  CREATE INDEX IX_content_keyword_candidate_status
    ON arion.content_keyword_candidate (tenant_id, status, keyword_difficulty);
GO
