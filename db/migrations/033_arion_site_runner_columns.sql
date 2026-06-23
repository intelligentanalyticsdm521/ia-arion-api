-- 033_arion_site_runner_columns.sql
-- TARGET DB: iadm_services (arion schema)
--
-- Adds the two columns the OnboardingRunner orchestrator
-- (routes/onboarding/runner.js) writes when it advances a site through
-- its post-checkout sequential setup flow:
--
--   • status_phase                — discrete machine-readable step name
--     the Portal Runner polls (see GET /onboarding/runner/status/:tid/:sid).
--     Distinct from provisioning_state (the existing top-level
--     'queued|running|ready|failed' lifecycle) and from
--     provisioning_details_json.current_phase (free-form label string).
--     status_phase is the runner's contract — adding it as a column makes
--     polling cheap (no JSON_VALUE per request) and lets the founder
--     dashboard filter by stuck phase via a B-tree index.
--
--   • consulting_migration_queued_at — populated by the migrate-path
--     terminal step. When NOT NULL the consulting team's hub surfaces
--     the tenant as a pending migration. Brandon decision 2026-06-23:
--     the migrate path is the only domain choice that intentionally
--     stops the runner and hands off to a human, so we want a dedicated
--     column rather than overloading provisioning_state with a custom
--     value the rest of the codebase doesn't know about.
--
-- Idempotent — re-running the migration is a no-op when the columns
-- already exist. Matches the COL_LENGTH() guard the runner uses at
-- read time so a tenant on an older schema falls back gracefully.

IF COL_LENGTH('arion.site', 'status_phase') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD status_phase NVARCHAR(60) NULL;
END
GO

IF COL_LENGTH('arion.site', 'consulting_migration_queued_at') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD consulting_migration_queued_at DATETIMEOFFSET NULL;
END
GO

-- Founder dashboard: "every site currently stuck mid-onboarding" — this
-- index keeps the lookup cheap. Filtered to non-terminal phases since
-- the vast majority of historical rows will be in 'ready' or 'failed'
-- (or NULL pre-migration) and we don't want them bloating the index.
--
-- FIX (2026-06-23) — SQL Server FILTERED INDEX does NOT support NOT IN in
-- the WHERE predicate. The original "NOT IN ('ready','failed','consulting_…')"
-- compiled to "Incorrect syntax near 'NOT'" and blocked every subsequent
-- migration (034 google/bing dual-path) for two consecutive pipelines.
-- Rewrite as explicit per-value <> conjunctions which IS supported.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_arion_site_status_phase_stuck')
  EXEC('CREATE INDEX IX_arion_site_status_phase_stuck
  ON arion.site (tenant_id, status_phase)
  WHERE status_phase IS NOT NULL
    AND status_phase <> ''ready''
    AND status_phase <> ''failed''
    AND status_phase <> ''consulting_migration_queued''');
GO

-- Consulting hub: pull migrations needing operator attention.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_arion_site_consulting_migration_pending')
CREATE INDEX IX_arion_site_consulting_migration_pending
  ON arion.site (consulting_migration_queued_at DESC, tenant_id)
  WHERE consulting_migration_queued_at IS NOT NULL;
GO
