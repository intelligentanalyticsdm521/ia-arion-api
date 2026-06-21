-- Migration 000: db.schema_migrations — pipeline migration tracking
--
-- Why:
--   Until this migration, every backend repo committed migrations but they were
--   never applied automatically. Someone had to remember to run a one-off
--   apply-migration-NNN.js script after every deploy. This was the recurring
--   "migrations never get applied" gap.
--
--   This table is the shared registry for ALL backend repos that write to
--   iadm_services (arion-api, oliver-api, LUMEN-API). The post-deploy pipeline
--   step in each repo reads this table to find already-applied migrations,
--   applies the new ones, and records them here.
--
--   Scoped by repo because each repo owns its own migration sequence
--   (arion-api 001..NNN, oliver-api 001..NNN, LUMEN-API 001..NNN — same numbers,
--   different bodies). PK is (repo, migration_id).
--
-- Bootstrap:
--   This file must be applied MANUALLY ONCE per environment (run from a dev
--   machine with `az login` + db_ddladmin):
--     node scripts/run-migration.js db/migrations/000_schema_migrations.sql
--   After that, the pipeline runner manages it for every future migration.
--
-- Idempotent: safe to run more than once.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'db')
  EXEC('CREATE SCHEMA db');
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE s.name = 'db' AND t.name = 'schema_migrations'
)
BEGIN
  CREATE TABLE db.schema_migrations (
    repo            NVARCHAR(64)  NOT NULL,
    migration_id    NVARCHAR(128) NOT NULL,
    filename        NVARCHAR(256) NOT NULL,
    sha256          CHAR(64)      NULL,
    applied_at      DATETIME2(3)  NOT NULL CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
    applied_by      NVARCHAR(128) NULL,
    build_id        NVARCHAR(64)  NULL,
    duration_ms     INT           NULL,
    CONSTRAINT PK_schema_migrations PRIMARY KEY (repo, migration_id)
  );
END
GO

-- Helpful index for "what's the latest migration applied for this repo?"
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_schema_migrations_repo_applied_at'
    AND object_id = OBJECT_ID('db.schema_migrations')
)
BEGIN
  CREATE INDEX IX_schema_migrations_repo_applied_at
    ON db.schema_migrations (repo, applied_at DESC);
END
GO
