-- Migration 024: AI Website Builder — block-emitter pipeline foundation
--
-- Scope (Phase 1 — backend only):
--   - lumen.ai_usage          : generic token-usage log keyed by surface + sub_kind
--                               (separate from lumen.ai_call_audit which is
--                                ARGUS-credit-metered; this is the lighter,
--                                always-on usage log every IL surface writes to)
--   - arion.site_block_draft  : persisted block JSON emitted for a site, kind
--                                (hero/services/etc.), with accept flag for
--                                draft-vs-published flow
--
-- Idempotent. Safe to re-run.
--
-- References:
--   overnight-report/38_AI_WEBSITE_BUILDER_v2_SCOPE.md
--   overnight-report/SCOPE_WORKING.md  (QUEUED: AI Website Builder, ~line 1939)
--   memory: reference_intelligence_layer_terminology.md
--             (this is the ARION IL surface — DO NOT brand "AI by Claude" externally)

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lumen') EXEC('CREATE SCHEMA lumen');
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');

-- ---------------------------------------------------------------------------
-- lumen.ai_usage
-- ---------------------------------------------------------------------------
-- One row per call to any IL/AI surface, written by callEmitter (and reusable
-- by future IL surfaces — SPARK AI Writer, OLIVER auto-categorize, etc.).
--
-- Purpose:
--   - per-tenant billing rollups (vs. ARGUS pool, which is the credit-pack
--     mechanism — this is the raw fact table behind it)
--   - founder dashboard: "which surfaces are burning the most tokens?"
--   - cost-allocation per platform (surface = 'arion.website_builder' etc.)
--
-- Keep wide enough that we never need a follow-up migration to add the
-- common fields (model_id, latency, error). Anything richer goes in
-- meta_json.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_usage' AND schema_id = SCHEMA_ID('lumen'))
BEGIN
  CREATE TABLE lumen.ai_usage (
    usage_id        BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    tenant_id       UNIQUEIDENTIFIER     NOT NULL,
    surface         NVARCHAR(50)         NOT NULL,   -- e.g. 'arion.website_builder', 'spark.ai_writer'
    sub_kind        NVARCHAR(50)         NULL,       -- e.g. 'hero', 'services', 'subject_line'
    provider        NVARCHAR(32)         NOT NULL DEFAULT 'anthropic',
    model_id        NVARCHAR(64)         NULL,
    input_tokens    INT                  NULL,
    output_tokens   INT                  NULL,
    latency_ms      INT                  NULL,
    cost_usd        NUMERIC(10, 4)       NULL,
    ok              BIT                  NOT NULL DEFAULT 1,
    error_code      NVARCHAR(64)         NULL,
    meta_json       NVARCHAR(MAX)        NULL,        -- free-form: site_id, user_id, prompt_hash, etc.
    occurred_at     DATETIME2            NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ai_usage_tenant_nonempty
      CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
  );

  CREATE INDEX IX_ai_usage_tenant_occurred
    ON lumen.ai_usage (tenant_id, occurred_at DESC);
  CREATE INDEX IX_ai_usage_surface_occurred
    ON lumen.ai_usage (surface, occurred_at DESC);
END;

-- ---------------------------------------------------------------------------
-- arion.site_block_draft
-- ---------------------------------------------------------------------------
-- Each generated block (one emitter run) lands here as a draft. The Portal
-- UI (future batch) lets the customer accept/reject; on accept, the page
-- assembler stitches accepted drafts into Elementor _elementor_data.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'site_block_draft' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.site_block_draft (
    block_id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
    tenant_id       UNIQUEIDENTIFIER NOT NULL,
    site_id         UNIQUEIDENTIFIER NOT NULL,
    kind            NVARCHAR(40)     NOT NULL,        -- 'hero' | 'services' | 'testimonials' | ...
    generated_json  NVARCHAR(MAX)    NOT NULL,        -- the validated emitter output (block-shape)
    elementor_json  NVARCHAR(MAX)    NULL,            -- elementorAdapter output (cached)
    model_id        NVARCHAR(64)     NULL,
    input_tokens    INT              NULL,
    output_tokens   INT              NULL,
    latency_ms      INT              NULL,
    accepted        BIT              NOT NULL DEFAULT 0,
    accepted_at     DATETIME2        NULL,
    accepted_by     UNIQUEIDENTIFIER NULL,
    created_at      DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    created_by      UNIQUEIDENTIFIER NULL,
    CONSTRAINT CK_site_block_draft_tenant_nonempty
      CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
  );

  CREATE INDEX IX_site_block_draft_site_kind_created
    ON arion.site_block_draft (site_id, kind, created_at DESC);
  CREATE INDEX IX_site_block_draft_tenant_created
    ON arion.site_block_draft (tenant_id, created_at DESC);
END;
