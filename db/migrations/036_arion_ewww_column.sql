-- 036_arion_ewww_column.sql
-- Plugin stack swap: ShortPixel → EWWW Image Optimizer.
-- Adds ewww_active column to site_plugin_snapshot so the snapshot timer can
-- record EWWW status for new sites. The legacy shortpixel_active column is
-- retained for existing sites still running ShortPixel during the transition.

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns
  WHERE [object_id] = OBJECT_ID(N'arion.site_plugin_snapshot')
    AND [name] = N'ewww_active'
)
BEGIN
  ALTER TABLE arion.site_plugin_snapshot
    ADD ewww_active BIT NULL;
END;
GO
