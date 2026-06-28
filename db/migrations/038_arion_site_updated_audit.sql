-- 038_arion_site_updated_audit.sql — Q-13/Q-14
-- ---------------------------------------------------------------------------
-- arion.site UPDATEs at POST /sites/:id/indexnow-key (~line 4268) and
-- POST /sites/:id/gbp/resolve (~line 989) lacked any record of WHICH
-- consultant or tenant user triggered the change. Site-config edits are
-- non-obvious to recover from when the wrong key/location is set, so
-- attribution matters for support and audit.
--
-- 2026-06-27

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE [object_id] = OBJECT_ID(N'arion.site') AND [name] = N'updated_by_user_id'
)
BEGIN
  ALTER TABLE arion.site ADD updated_by_user_id UNIQUEIDENTIFIER NULL;
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE [object_id] = OBJECT_ID(N'arion.site') AND [name] = N'updated_by_grant_id'
)
BEGIN
  ALTER TABLE arion.site ADD updated_by_grant_id UNIQUEIDENTIFIER NULL;
END;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE [object_id] = OBJECT_ID(N'arion.site') AND [name] = N'updated_by_organization'
)
BEGIN
  ALTER TABLE arion.site ADD updated_by_organization NVARCHAR(120) NULL;
END;
GO
