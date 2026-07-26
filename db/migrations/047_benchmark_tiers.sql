-- 047_benchmark_tiers.sql
--
-- Extends arion.ia_insights_benchmark into the three-tier industry benchmark
-- store (Brandon 2026-07-26): tier 'high' (service_industry level, e.g.
-- home_services / medical_practice), 'medium' (vertical level, e.g.
-- dental_practice / snow_removal — broader than current clients on purpose),
-- 'detail' (local level, e.g. local:des_moines_ia:dental_practice — seeded
-- from our own competitor/CrUX pulls, never fabricated), plus 'model' rows
-- for scoring-model constants (e.g. expected CTR by SERP position).
-- Every row now carries its SOURCE and as-of date so the quarterly model
-- review can refresh with provenance. Additive + guarded; safe re-run.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'arion.ia_insights_benchmark') AND name = 'tier')
  ALTER TABLE arion.ia_insights_benchmark ADD tier NVARCHAR(20) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'arion.ia_insights_benchmark') AND name = 'source')
  ALTER TABLE arion.ia_insights_benchmark ADD source NVARCHAR(300) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'arion.ia_insights_benchmark') AND name = 'as_of')
  ALTER TABLE arion.ia_insights_benchmark ADD as_of DATE NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'arion.ia_insights_benchmark') AND name = 'p75_value')
  ALTER TABLE arion.ia_insights_benchmark ADD p75_value FLOAT NULL;
