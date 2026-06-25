-- 037_arion_apple_claimed_at.sql
-- Apple Business Connect has no OAuth/API, so the claim flow is manual:
-- the founder (or client) clicks "Mark as Claimed" in the Portal after
-- finishing the Apple Business Connect signup at register.apple.com/business.
--
-- This migration adds the timestamp column that records WHEN the claim
-- happened. The existing `apple_claimed BIT` column from 001_arion_schema_v2.sql
-- stays as-is — `apple_claimed_at` is additive and NULL for unclaimed sites.
-- Setting apple_claimed back to 0 (unmark) nulls the timestamp.

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns
  WHERE [object_id] = OBJECT_ID(N'arion.site')
    AND [name] = N'apple_claimed_at'
)
BEGIN
  ALTER TABLE arion.site
    ADD apple_claimed_at DATETIMEOFFSET NULL;
END;
GO
