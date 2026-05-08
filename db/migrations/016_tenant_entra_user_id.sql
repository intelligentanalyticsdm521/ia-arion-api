-- Migration 016: Track the Entra External ID user ID per tenant
-- Set when the portal account is created via Microsoft Graph after a site goes live.
-- Used for idempotency so retries don't double-create users.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'entra_user_id' AND Object_ID = Object_ID('arion.tenant'))
  ALTER TABLE arion.tenant ADD entra_user_id NVARCHAR(80) NULL;

-- EXEC wraps the CREATE INDEX so the parser doesn't try to resolve the column
-- before the ALTER TABLE above runs. (T-SQL compiles the whole batch up front.)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tenant_entra_user' AND object_id = OBJECT_ID('arion.tenant'))
  EXEC('CREATE INDEX IX_tenant_entra_user ON arion.tenant(entra_user_id) WHERE entra_user_id IS NOT NULL');
