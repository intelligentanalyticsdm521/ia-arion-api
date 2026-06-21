-- 030_arion_platform_pulse_cache.sql
--
-- Brandon 2026-06-21 — Platform Pulse cache for ARION.
--
-- BRANDON'S FINAL INSIGHTS ARCHITECTURE:
--   Platform Pulse = (Trend Score + Intelligence Score) / 2 (per-platform)
--   Business Pulse = average of ALL active Platform Pulses (equal weight)
--
-- This table holds the cached Platform Pulse for ARION per-tenant.
-- Refreshed lazily (6h TTL) by the /intelligence/arion/platform-pulse/:tenantId
-- endpoint and proxied by platform-api when computing Business Pulse.
--
-- Single source data: ARION trend + intelligence ONLY (no cross-platform).
--
-- Idempotent (IF NOT EXISTS).
--
-- TARGET DB: iadm_services.

IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name='arion' AND t.name='platform_pulse_cache')
BEGIN
  CREATE TABLE arion.platform_pulse_cache (
    tenant_id              UNIQUEIDENTIFIER NOT NULL,
    score                  DECIMAL(5,2)     NULL,  -- Platform Pulse (0-100) — NULL when no data
    trend_component        DECIMAL(5,2)     NULL,  -- Trend Score component (0-100)
    intelligence_component DECIMAL(5,2)     NULL,  -- Intelligence Score component (0-100)
    /* When only one component is present, score = that component and
       partial = 1. When both null, score = NULL and no_data = 1. The cache
       row is still written so downstream readers don't keep recomputing. */
    partial                BIT              NOT NULL CONSTRAINT DF_arpp_partial DEFAULT 0,
    no_data                BIT              NOT NULL CONSTRAINT DF_arpp_nodata DEFAULT 0,
    calculated_at          DATETIMEOFFSET   NOT NULL CONSTRAINT DF_arpp_calc DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_arion_platform_pulse_cache PRIMARY KEY (tenant_id)
  );
  CREATE INDEX IX_arion_platform_pulse_cache_calc
    ON arion.platform_pulse_cache (calculated_at DESC);
END
GO
