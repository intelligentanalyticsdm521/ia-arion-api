-- 044_ia_insights_monthly_periods.sql
--
-- IA Insights scores are MONTHLY reports. The underlying feeds may be daily
-- or weekly, but a score belongs to a calendar month and there must be
-- exactly ONE row per (tenant, site, report_key, month).
--
-- Before this, POST /arion/ia-insights/scores stored whatever period_end the
-- browser posted, and the Trends page writes on every visit — so a single
-- month accumulated several "periods". Prod evidence (IA tenant, June 2026):
--   2026-06-17, 2026-06-21, 2026-06-22, 2026-06-26  → four rows for one month
-- That makes month-over-month comparison meaningless and renders the
-- sparkline as noise rather than trend.
--
-- This migration:
--   1. Collapses existing rows to one per calendar month, keeping the LATEST
--      row in each month (most recent data wins).
--   2. Rewrites period_start / period_end to true month boundaries.
--   3. Adds a unique index so the invariant is enforced by the database, not
--      just by the route.
--
-- Idempotent: safe to re-run.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- 1. Keep the newest row per (tenant, site, report_key, month); delete the rest.
;WITH ranked AS (
  SELECT
    id_col = ROW_NUMBER() OVER (
      PARTITION BY tenant_id, site_id, report_key,
                   DATEFROMPARTS(YEAR(period_end), MONTH(period_end), 1)
      ORDER BY period_end DESC, updated_at DESC
    ),
    *
  FROM arion.ia_insights_score_history
)
DELETE FROM ranked WHERE id_col > 1;

-- 2. Snap the survivors to calendar-month boundaries.
UPDATE arion.ia_insights_score_history
SET period_start = DATEFROMPARTS(YEAR(period_end), MONTH(period_end), 1),
    period_end   = EOMONTH(period_end)
WHERE period_start <> DATEFROMPARTS(YEAR(period_end), MONTH(period_end), 1)
   OR period_end   <> EOMONTH(period_end);

-- 3. Enforce one row per report per month at the database level.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_ia_insights_score_month'
    AND object_id = OBJECT_ID('arion.ia_insights_score_history')
)
  CREATE UNIQUE INDEX UQ_ia_insights_score_month
    ON arion.ia_insights_score_history (tenant_id, site_id, report_key, period_end);

COMMIT TRANSACTION;
