-- 068_site_audit_attempts_and_copies.sql
--
-- Two columns on arion.site_audit_run (the website check, migration 067):
--
--   run_attempts        how many times a worker has started this run. A run
--                       lost to a restart is started again (lib/audit/runner.js
--                       sweep and a repeat POST), at most twice in all, so a
--                       website that kills the worker cannot loop forever.
--   copied_from_run_id  set on a same-website-today copy (no new crawl). The
--                       caller's daily limit counts only rows where this is
--                       NULL, i.e. checks that really ran.
--
-- Additive and idempotent: safe to pre-apply before the code push
-- (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

IF COL_LENGTH('arion.site_audit_run', 'run_attempts') IS NULL
  ALTER TABLE arion.site_audit_run ADD run_attempts INT NOT NULL CONSTRAINT DF_sar_attempts DEFAULT 0;
GO

IF COL_LENGTH('arion.site_audit_run', 'copied_from_run_id') IS NULL
  ALTER TABLE arion.site_audit_run ADD copied_from_run_id UNIQUEIDENTIFIER NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_site_audit_run_status' AND object_id = OBJECT_ID('arion.site_audit_run'))
  CREATE INDEX IX_site_audit_run_status ON arion.site_audit_run (status, created_at) INCLUDE (started_at, run_attempts);
GO
