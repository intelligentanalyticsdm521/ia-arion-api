-- 031_intelligence_cache.sql
--
-- F-INTEL (2026-06-21) — Server-side cache for ARION Intelligence reports.
-- Sister-migration to 030_arion_platform_pulse_cache.sql; that one stores
-- the per-tenant Platform Pulse, this one stores the per-(site,report)
-- Intelligence calculator output that feeds the Intelligence Score side
-- of the (Trend + Intel)/2 = Platform Pulse equation.
--
-- The Intelligence page renders 6 SINGLE-SOURCE cached reports per ARION
-- site (Brandon's locked architecture 2026-06-21 — no cross-platform data
-- in any ARION report; cross-platform intelligence lives in ARGUS):
--   1. SEO Authority Position           (seo_authority)        — SE Ranking
--   2. Visibility Trajectory            (visibility_trajectory) — GSC
--   3. Competitive Presence Gap         (competitive_presence) — SE Ranking
--   4. Crawl Depth Score                (crawl_depth)          — SE Ranking audit
--   5. Schema Markup Coverage           (schema_coverage)      — SE Ranking + IA Plugin
--   6. Page Speed Distribution          (pagespeed_distribution) — pagespeed snapshots
--
-- relocated_to column flags rows that have been migrated to another
-- product surface (e.g. lead_source/content_roi/rep_revenue moved into
-- ARGUS Cross-Platform Intelligence per the refactor). Keeps the row for
-- audit trail but excludes it from /arion/intelligence responses.
--
-- Each calculator hits external APIs (SE Ranking, GSC, PSI) which are
-- rate-limited and slow. We cache the computed result with a 12-hour TTL
-- so a tenant browsing through Intelligence doesn't hammer SE Ranking on
-- every page-view. A nightly cron in arion-func refreshes active tenants.
--
-- last_calculated_at + expires_at are stored explicitly (not derived from
-- updated_at) so the cron worker can refresh entries that are about to
-- expire without racing against another writer. Unique index on
-- (tenant_id, site_id, report_key) — one row per (site × report).
--
-- IDEMPOTENT. Wrapped in IF NOT EXISTS guards so re-running is safe.
--
-- TARGET DB: iadm_services.

IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name='arion' AND t.name='intelligence_cache')
BEGIN
  CREATE TABLE arion.intelligence_cache (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    tenant_id           UNIQUEIDENTIFIER NOT NULL,
    site_id             UNIQUEIDENTIFIER NOT NULL,
    /* report_key matches one of:
       seo_authority | visibility_trajectory | competitive_presence |
       crawl_depth | schema_coverage | pagespeed_distribution */
    report_key          NVARCHAR(40)     NOT NULL,
    score               INT              NULL,         -- 0-100 (null on error / insufficient data)
    tier_grade          NVARCHAR(2)      NULL,         -- A | B | C | D
    /* JSON serialization of the calculator's full result:
       { score, tier, components, narrative, last_calculated_at, ... } */
    payload_json        NVARCHAR(MAX)    NOT NULL,
    /* Independent timestamps so the cron worker can detect TTL expiry
       without depending on updated_at (which we'd also bump on no-op upserts). */
    last_calculated_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    expires_at          DATETIME2        NOT NULL,
    /* Set when a report has been moved to a different product surface
       (e.g. argus_cross_channel for relocated multi-platform reports).
       Excluded from the /arion/intelligence response when NOT NULL. */
    relocated_to        NVARCHAR(60)     NULL,
    created_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE UNIQUE INDEX UX_arion_intel_cache_lookup
    ON arion.intelligence_cache(tenant_id, site_id, report_key);

  CREATE INDEX IX_arion_intel_cache_expiry
    ON arion.intelligence_cache(expires_at)
    INCLUDE (tenant_id, site_id, report_key);
END
ELSE
BEGIN
  /* Column add for installations that pre-existed the relocate flag. */
  IF NOT EXISTS (SELECT 1 FROM sys.columns c JOIN sys.tables t ON c.object_id=t.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name='arion' AND t.name='intelligence_cache' AND c.name='relocated_to')
    ALTER TABLE arion.intelligence_cache ADD relocated_to NVARCHAR(60) NULL;
END
GO

/* ----------------------------------------------------------------------
   Soft-delete: flag any legacy multi-platform cached rows so the
   /arion/intelligence aggregator skips them. Pure UPDATE — safe to
   re-run; only matches rows whose report_key was used by the prior
   cross-platform schema. The new single-source calculators write
   under different keys (see comment block above).
   ---------------------------------------------------------------------- */
UPDATE arion.intelligence_cache
   SET relocated_to = 'argus_cross_channel',
       updated_at   = SYSUTCDATETIME()
 WHERE relocated_to IS NULL
   AND report_key IN (
     'lead_source_quality',
     'content_roi',
     'reputation_revenue',
     'acquisition_efficiency',  -- folded into seo_authority for single-source compliance
     'content_gap',             -- renamed to competitive_presence
     'ranking_velocity',
     'cluster_coverage',
     'local_pack',
     'backlink_quality'
   );
GO
