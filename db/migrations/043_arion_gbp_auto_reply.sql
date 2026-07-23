-- 043_arion_gbp_auto_reply.sql
--
-- Pro+ auto-reply automation for Google Business Profile reviews
-- (Brandon 2026-07-22). Per-site opt-in + a minimum-star gate so owners can
-- auto-reply to happy reviews only and hand-craft the tough ones. The
-- arion-func worker reads these to decide what to answer.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'gbp_auto_reply' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD gbp_auto_reply BIT NOT NULL DEFAULT 0;
GO

-- Minimum star rating that auto-reply will answer (default 4 = only 4-5★;
-- an owner can lower to 1 to auto-reply to everything).
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'gbp_auto_reply_min_stars' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD gbp_auto_reply_min_stars TINYINT NOT NULL DEFAULT 4;
GO

PRINT '  + arion.site.gbp_auto_reply + gbp_auto_reply_min_stars';
