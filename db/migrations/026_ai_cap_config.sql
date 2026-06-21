-- Migration 026: lumen.ai_cap_config — per-tenant AI spend caps
--
-- Why:
--   callEmitter (lib/websiteBuilder/callEmitter.js, commit 67dcb83) LOGS cost
--   to lumen.ai_usage but does NOT enforce a per-tenant cap. The ARGUS
--   callWrapper has the credit-pool guard for credit-metered paths; the
--   website builder bills against the ARGUS Data Plan tier and needs its own
--   $ floor cap as a safety guard before public beta.
--
--   This table holds one row per (tenant, surface) with monthly + optional
--   daily $ caps. costGuard.js reads it before every callEmitter call and
--   returns ok=false → HTTP 402 when spend + estimate exceeds cap.
--
--   When no row exists for a tenant, costGuard falls back to env-var defaults
--   (AI_BUILDER_DEFAULT_MONTHLY_CAP_USD, default $100/mo).
--
-- Keys / shape:
--   PK is (tenant_id, surface) — one row per surface per tenant. Today we
--   only write 'arion.website_builder' rows but the column lets SPARK AI
--   Writer / OLIVER auto-categorize land here without a follow-up migration.
--
-- Idempotent. Safe to re-run.
--
-- References:
--   lib/websiteBuilder/costGuard.js          (this migration's consumer)
--   db/migrations/024_ai_website_builder.sql (lumen.ai_usage — the spend log)
--   memory: reference_argus_product_stack.md (Data Plan tier — $ cap is the
--           floor; the Data Plan token budget is the ceiling)

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lumen') EXEC('CREATE SCHEMA lumen');

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_cap_config' AND schema_id = SCHEMA_ID('lumen'))
BEGIN
  CREATE TABLE lumen.ai_cap_config (
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    surface          NVARCHAR(50)     NOT NULL CONSTRAINT DF_ai_cap_config_surface DEFAULT 'arion.website_builder',
    monthly_cap_usd  DECIMAL(10, 2)   NOT NULL CONSTRAINT DF_ai_cap_config_monthly_cap DEFAULT 100.00,
    daily_cap_usd    DECIMAL(10, 2)   NULL,
    updated_at       DATETIMEOFFSET   NOT NULL CONSTRAINT DF_ai_cap_config_updated_at DEFAULT SYSDATETIMEOFFSET(),
    updated_by       UNIQUEIDENTIFIER NULL,
    notes            NVARCHAR(500)    NULL,
    CONSTRAINT PK_ai_cap_config PRIMARY KEY (tenant_id, surface),
    CONSTRAINT CK_ai_cap_config_tenant_nonempty
      CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
    CONSTRAINT CK_ai_cap_config_monthly_nonneg
      CHECK (monthly_cap_usd >= 0),
    CONSTRAINT CK_ai_cap_config_daily_nonneg
      CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0)
  );
END;

PRINT 'Migration 026 applied: lumen.ai_cap_config created.';
