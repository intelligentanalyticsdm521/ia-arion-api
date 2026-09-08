-- 064_content_agent_tenant_config.sql
--
-- Per-tenant configuration for the Content & Social Agent.
--
-- Brandon 2026-08-23: "the agent is a product that we would sell to our clients
-- so it would go on their tenant when signed up." THIS ROW is what "goes on
-- their tenant" means. Signup writes one; the weekly tick runs for every row
-- with enabled = 1 and for nobody else. No row, no runs, no cost.
--
-- It also carries the two things Brandon's 2026-08-24 direction added:
--
--   * keyword_provider — SEO tools are OPTIONAL inputs, not the spine. A tenant
--     with SE Ranking gets full research; one with only the IA plugin gets
--     RankMath-informed selection; one with neither still gets an agent, plus
--     an upsell line ("make your agent smarter by adding SEO tools").
--     'auto' resolves at run time from what the tenant actually has.
--
--   * price_usd_monthly — what THIS tenant pays for the agent, so the 60% rule
--     (LLM spend must stay under 60% of price) is checked per tenant against a
--     real number. NULL means "price not set; margin check reports unknown" —
--     deliberately NOT a hardcoded default, per the standing no-fabricated-
--     catalog rule: prices come from configuration, never from code.
--
-- The JSON name lists exist because guardrails (21.6) need tenant-scoped facts:
--
-- RENUMBERED 054 -> 064 (2026-09-08). This file was written against a working
-- copy where 054 was free; on release/sept-a-2026 054 is
-- 054_site_internal_ip_list.sql and 055/059/061 are taken as well. 064 is
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
-- which real names are protected, which are approved, who the competitors are,
-- and which features actually shipped. They are per-tenant data, so they live
-- on the tenant's row, not in code.

IF OBJECT_ID('arion.content_agent_tenant_config', 'U') IS NULL
BEGIN
  CREATE TABLE arion.content_agent_tenant_config (
    tenant_id        UNIQUEIDENTIFIER NOT NULL
      CONSTRAINT PK_content_agent_tenant_config PRIMARY KEY,
    site_id          UNIQUEIDENTIFIER NULL,

    enabled          BIT              NOT NULL
      CONSTRAINT DF_ca_tenant_config_enabled DEFAULT 0,

    -- how many content units per weekly cycle
    slots_per_cycle  INT              NOT NULL
      CONSTRAINT DF_ca_tenant_config_slots DEFAULT 1,
    content_types    NVARCHAR(200)    NOT NULL
      CONSTRAINT DF_ca_tenant_config_types DEFAULT 'blog_post',

    -- 'auto' = resolve from what the tenant has: se_ranking > rankmath > none
    keyword_provider NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_ca_tenant_config_provider DEFAULT 'auto'
      CONSTRAINT CK_ca_tenant_config_provider
        CHECK (keyword_provider IN ('auto','se_ranking','rankmath','none')),

    authority_stage  NVARCHAR(20)     NOT NULL
      CONSTRAINT DF_ca_tenant_config_stage DEFAULT 'new',

    brand_voice      NVARCHAR(MAX)    NULL,

    -- guardrail facts, tenant-scoped (Decision Rule 21.6)
    protected_client_names_json NVARCHAR(MAX) NULL,
    approved_client_names_json  NVARCHAR(MAX) NULL,
    competitor_names_json       NVARCHAR(MAX) NULL,
    shipped_features_json       NVARCHAR(MAX) NULL,

    -- the 60% rule's denominator. NULL = margin check reports 'price not set'.
    price_usd_monthly DECIMAL(10,2)   NULL,

    -- sticky F8 halt: set by the breaker, cleared only by a human
    halted_at        DATETIMEOFFSET   NULL,
    halted_reason    NVARCHAR(400)    NULL,

    created_at       DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_ca_tenant_config_cre DEFAULT SYSDATETIMEOFFSET(),
    updated_at       DATETIMEOFFSET   NULL
  );
END
GO

-- the tick's query: every enabled, un-halted tenant
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ca_tenant_config_enabled' AND object_id = OBJECT_ID('arion.content_agent_tenant_config'))
  CREATE INDEX IX_ca_tenant_config_enabled
    ON arion.content_agent_tenant_config (enabled)
    WHERE enabled = 1;
GO
