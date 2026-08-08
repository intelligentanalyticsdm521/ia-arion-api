-- 045_ia_insights_six_report_model.sql
--
-- ARION Trends: 8 report keys -> 6 (Brandon, 2026-07-24).
--
-- Three CHANNEL reports (where you show up) + three QUALITY reports (how well
-- it works). Six is a ceiling, not a target.
--
--   visibility + search   -> search_visibility
--   local                 -> local_presence
--   audience + conversion -> audience_conversion
--   content               -> content     (unchanged)
--   technical             -> technical   (unchanged)
--   social_presence       -> NEW, no history to migrate
--   presence              -> DELETED
--
-- Why `presence` is deleted rather than renamed: it was never a report. It is
-- businessPresenceEngine(), the weighted composite of the other reports — and
-- it was ALSO being written into score history, so platformPulse averaged the
-- composite alongside its own components. That double count is the "math that
-- doesn't reconcile" the 2026-06-28 insights gate was raised for.
--
-- History is PRESERVED, not dropped. For the two merges we average the
-- constituent scores per month, which is the honest carry-forward: both halves
-- contributed to the merged report's meaning, and discarding one would put a
-- false step change in the client's trend line.
--
-- Depends on 044 (monthly periods + UQ_ia_insights_score_month). Idempotent.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- The unique key would block the intermediate states below (both old keys
-- briefly carry the new name before the merge collapses them), so drop every
-- unique index over (tenant_id, site_id, report_key, period_end) and rebuild
-- exactly ONE at the end.
--
-- There are two possible names in the wild: UX_arion_ia_score_history_unique
-- from the base schema, and UQ_ia_insights_score_month which an earlier
-- revision of migration 044 created redundantly over the same columns. This
-- collapses them to one.
DECLARE @ix SYSNAME, @drop NVARCHAR(MAX) = N'';
DECLARE ix_cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT i.name FROM sys.indexes i
  WHERE i.object_id = OBJECT_ID('arion.ia_insights_score_history')
    AND i.is_unique = 1 AND i.is_primary_key = 0
    AND (SELECT COUNT(*) FROM sys.index_columns ic
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id) = 4
    AND NOT EXISTS (
      SELECT 1 FROM sys.index_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
        AND c.name NOT IN ('tenant_id','site_id','report_key','period_end'));
OPEN ix_cur; FETCH NEXT FROM ix_cur INTO @ix;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @drop = @drop + N'DROP INDEX ' + QUOTENAME(@ix) + N' ON arion.ia_insights_score_history;';
  FETCH NEXT FROM ix_cur INTO @ix;
END
CLOSE ix_cur; DEALLOCATE ix_cur;
IF LEN(@drop) > 0 EXEC sp_executesql @drop;

-- 1. `presence` was never a report — remove the double-counted rows.
DELETE FROM arion.ia_insights_score_history WHERE report_key = 'presence';

-- 2. Straight renames (no merge partner).
UPDATE arion.ia_insights_score_history SET report_key = 'local_presence' WHERE report_key = 'local';

-- 3. Merges — average the constituents per (tenant, site, month), then collapse.
--    Written as: rewrite BOTH old keys to the new key, then average duplicates.
UPDATE arion.ia_insights_score_history SET report_key = 'search_visibility'
  WHERE report_key IN ('visibility', 'search');
UPDATE arion.ia_insights_score_history SET report_key = 'audience_conversion'
  WHERE report_key IN ('audience', 'conversion');

;WITH merged AS (
  SELECT tenant_id, site_id, report_key, period_end,
         avg_score = AVG(CAST(score AS FLOAT)),
         keep_id   = MIN(CAST(snapshot_key AS VARBINARY(16)))
  FROM (
    SELECT *, snapshot_key = CAST(CONCAT(tenant_id, site_id, report_key, period_end) AS VARBINARY(16))
    FROM arion.ia_insights_score_history
    WHERE report_key IN ('search_visibility', 'audience_conversion')
  ) x
  GROUP BY tenant_id, site_id, report_key, period_end
  HAVING COUNT(*) > 1
)
-- 2026-08-08 FIX: the `merged` CTE is filtered by HAVING COUNT(*) > 1, so it only
-- contains groups that actually HAVE a merge partner. This UPDATE, however, targeted
-- every row with those report keys — so a row whose pair never existed (only 'search'
-- but no 'visibility', say) got a correlated subquery returning no rows -> NULL, and
-- `score` is NOT NULL -> "Cannot insert the value NULL into column 'score'".
--
-- Prod survived by luck: every group there happened to be paired, so the migration
-- succeeded on 2026-08-08. Dev had one unpaired row and it failed immediately. Any
-- fresh environment would hit the same wall, so this is fixed in place rather than in
-- a follow-up migration — a new migration cannot rescue an environment that dies on 045.
--
-- EXISTS restricts the update to genuinely merged groups; singletons keep their own
-- score, which is the correct behaviour and what the surrounding comments intended.
UPDATE h
SET h.score = (SELECT ROUND(m.avg_score, 0) FROM merged m
               WHERE m.tenant_id = h.tenant_id AND m.site_id = h.site_id
                 AND m.report_key = h.report_key AND m.period_end = h.period_end)
FROM arion.ia_insights_score_history h
WHERE h.report_key IN ('search_visibility', 'audience_conversion')
  AND EXISTS (SELECT 1 FROM merged m
               WHERE m.tenant_id = h.tenant_id AND m.site_id = h.site_id
                 AND m.report_key = h.report_key AND m.period_end = h.period_end);

-- Now every duplicate carries the same averaged score; keep one of each.
;WITH ranked AS (
  SELECT rn = ROW_NUMBER() OVER (
           PARTITION BY tenant_id, site_id, report_key, period_end
           ORDER BY updated_at DESC), *
  FROM arion.ia_insights_score_history
)
DELETE FROM ranked WHERE rn > 1;

-- 4. Anything not in the canonical six is stale (older experiments, the
--    seeder's invented keys). Drop it so the Pulse average can't be polluted.
DELETE FROM arion.ia_insights_score_history
WHERE report_key NOT IN ('search_visibility', 'local_presence', 'social_presence',
                         'audience_conversion', 'content', 'technical');

-- 5. Restore the one-row-per-report-per-month invariant — exactly one index.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'UQ_ia_insights_score_month'
                 AND object_id = OBJECT_ID('arion.ia_insights_score_history'))
  CREATE UNIQUE INDEX UQ_ia_insights_score_month
    ON arion.ia_insights_score_history (tenant_id, site_id, report_key, period_end);

COMMIT TRANSACTION;
