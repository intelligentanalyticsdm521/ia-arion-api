-- 032_arion_page_voice_score.sql
--
-- Wave 3 — Brand Voice Monitor wiring for ARION pages.
--
-- Pages live in WordPress, not in our DB — so we can't add a column to a
-- non-existent arion.page table. Instead, we keep a per-(site, page_url)
-- voice-score row that the nightly arion-func timer
-- (arionPageVoiceScore) writes after pulling recent published pages from
-- the IA Plugin /content/pages-recent endpoint and scoring each body
-- through LUMEN-API's POST /api/v1/my-brand/voice/score.
--
-- The actual audit trail (one row per scoreText call with drift_reasons,
-- cost, embedding cosine etc.) lives in lumen.brand_voice_check — the
-- table created in LUMEN-API migration 052. This table is a denormalized
-- "latest score per page" projection so portal surfaces (ARION Insights,
-- Voice Monitor dashboard) can join it cheaply without scanning the full
-- check audit log every render.
--
-- Mirrors the (site_id + page_url) compound key used by
-- arion.site_page_watch from migration 009.

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.page_voice_score') AND type = 'U')
CREATE TABLE arion.page_voice_score (
  page_voice_score_id BIGINT           IDENTITY(1,1) PRIMARY KEY,
  tenant_id           UNIQUEIDENTIFIER NOT NULL,
  site_id             UNIQUEIDENTIFIER NOT NULL,
  page_url            NVARCHAR(1000)   NOT NULL,
  page_title          NVARCHAR(500)    NULL,
  wp_post_id          INT              NULL,
  wp_post_type        NVARCHAR(40)     NULL,  -- 'page' | 'post' | other CPT
  body_sha256         NVARCHAR(64)     NULL,  -- short-circuit re-scoring when WP body unchanged
  voice_score         DECIMAL(5,4)     NULL,  -- 0..1, NULL until first scan succeeds
  drift_reasons_json  NVARCHAR(MAX)    NULL,  -- JSON array of <=3 strings
  source              NVARCHAR(40)     NULL,  -- 'embedding_only' | 'embedding_then_haiku' | 'cache_hit'
  check_id            BIGINT           NULL,  -- FK-ish to lumen.brand_voice_check.check_id (no hard FK across DBs)
  last_scanned_at     DATETIMEOFFSET   NULL,
  created_at          DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at          DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_page_voice_score_site_url')
CREATE UNIQUE INDEX UQ_page_voice_score_site_url
  ON arion.page_voice_score (site_id, page_url);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_voice_score_tenant_scanned')
CREATE INDEX IX_page_voice_score_tenant_scanned
  ON arion.page_voice_score (tenant_id, last_scanned_at DESC);

-- For drift dashboards: pull off-brand pages first.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_page_voice_score_tenant_score')
CREATE INDEX IX_page_voice_score_tenant_score
  ON arion.page_voice_score (tenant_id, voice_score)
  WHERE voice_score IS NOT NULL;
