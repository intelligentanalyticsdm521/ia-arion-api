-- later/070_drop_moved_agent_switches.sql
--
-- ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1_2026-10-08 §A.2).
--
-- NOT READY TO RUN. This file sits in db/migrations/later/, which no migration
-- runner reads. It is moved into db/migrations/ in the release AFTER the
-- phase-1 code is on production and clicked: the switches these columns held
-- now live in iadm_platform core.team_job_setting (written by platform-api),
-- and the Brief facts in core.business_profile. A drop before the code would
-- break the code that is still running (migrations before code; drops after).
--
-- From the phase-1 code on, no file in this repo reads or writes these columns
-- (pinned by test/team-runners-arion.test.mjs, "no file reads the moved
-- switches").
--
-- Each column: its default and check constraints and any index that names it
-- are dropped first, then the column. Guarded and idempotent.
--
-- TARGET DB: iadm_services.

DECLARE @drops TABLE (tbl SYSNAME, col SYSNAME);
INSERT INTO @drops (tbl, col) VALUES
  (N'arion.site', N'gbp_auto_reply'),
  (N'arion.site', N'gbp_auto_reply_min_stars'),
  (N'arion.content_agent_tenant_config', N'enabled'),
  (N'arion.content_agent_tenant_config', N'slots_per_cycle'),
  (N'arion.content_agent_tenant_config', N'content_types'),
  (N'arion.content_agent_tenant_config', N'brand_voice'),
  (N'arion.content_agent_tenant_config', N'protected_client_names_json'),
  (N'arion.content_agent_tenant_config', N'approved_client_names_json'),
  (N'arion.content_agent_tenant_config', N'competitor_names_json'),
  (N'arion.content_agent_tenant_config', N'shipped_features_json');

DECLARE @tbl SYSNAME, @col SYSNAME, @stmt NVARCHAR(MAX);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col FROM @drops;
OPEN c;
FETCH NEXT FROM c INTO @tbl, @col;
WHILE @@FETCH_STATUS = 0
BEGIN
  IF COL_LENGTH(@tbl, @col) IS NOT NULL
  BEGIN
    SET @stmt = N'';
    SELECT @stmt = @stmt + N'ALTER TABLE ' + @tbl + N' DROP CONSTRAINT ' + QUOTENAME(dc.name) + N';'
      FROM sys.default_constraints dc
      JOIN sys.columns cl ON cl.object_id = dc.parent_object_id AND cl.column_id = dc.parent_column_id
     WHERE dc.parent_object_id = OBJECT_ID(@tbl) AND cl.name = @col;
    SELECT @stmt = @stmt + N'ALTER TABLE ' + @tbl + N' DROP CONSTRAINT ' + QUOTENAME(cc.name) + N';'
      FROM sys.check_constraints cc
      JOIN sys.columns cl ON cl.object_id = cc.parent_object_id AND cl.column_id = cc.parent_column_id
     WHERE cc.parent_object_id = OBJECT_ID(@tbl) AND cl.name = @col;
    SELECT @stmt = @stmt + N'DROP INDEX ' + QUOTENAME(i.name) + N' ON ' + @tbl + N';'
      FROM sys.indexes i
     WHERE i.object_id = OBJECT_ID(@tbl) AND i.is_primary_key = 0
       AND EXISTS (SELECT 1 FROM sys.index_columns ic
                     JOIN sys.columns cl ON cl.object_id = ic.object_id AND cl.column_id = ic.column_id
                    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND cl.name = @col);
    SET @stmt = @stmt + N'ALTER TABLE ' + @tbl + N' DROP COLUMN ' + QUOTENAME(@col) + N';';
    EXEC sp_executesql @stmt;
    PRINT '  - ' + @tbl + '.' + @col;
  END
  ELSE
    PRINT '  = ' + @tbl + '.' + @col + ' already gone';
  FETCH NEXT FROM c INTO @tbl, @col;
END
CLOSE c;
DEALLOCATE c;
GO
