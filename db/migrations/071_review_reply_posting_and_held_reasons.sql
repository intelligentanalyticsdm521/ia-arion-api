-- 071_review_reply_posting_and_held_reasons.sql
--
-- ARGUS employees, phase 1, the fixer pass on stream 2 (2026-10-08).
--
--   1. arion.gbp_reply_draft.status gains 'posting'. A reply is CLAIMED
--      before it is posted (held/failed -> posting -> posted/failed), so two
--      approvals at the same moment cannot both post, and a reply approved in
--      advance is never stored as 'held' (which read "Send me first") while it
--      is being posted. decided_at on a 'posting' row is when the post started.
--   2. arion.content_agent_output.held_reason: WHY a draft waits, written when
--      it is saved and when an approval in advance fails (send_me_first |
--      always_asks | quality | automatic_failed). The Needs-you sentence comes
--      from it; it no longer says "Send me first" for a draft that waited for
--      another reason.
--   3. arion.content_agent_output.checks_json: the names of the checks this
--      draft ran (the job's platform checks plus the ones its pinned job
--      description added). Approving an escalated draft with changed words
--      runs exactly these again.
--   4. The price row for 'arion.review_reply', the Google review replies JOB's
--      own action (agent spend, inside the suite spending limit). Same price as
--      the owner's 'my_brand.review_reply' button, copied from that row when it
--      exists, in BOTH pricing homes (the 065 rule: a row seeded into one home
--      disappears at consolidation).
--
-- NOTHING HERE BELONGS TO ONE BUSINESS. Idempotent and additive: safe to
-- pre-apply before the code push (feedback_migrations_before_code_push).
-- db/migrations/later/070 (the drops for the release after) is unaffected.
--
-- TARGET DB: iadm_services.

IF OBJECT_ID('arion.gbp_reply_draft','U') IS NOT NULL
   AND EXISTS (SELECT 1 FROM sys.check_constraints
                WHERE name = 'CK_gbp_reply_draft_status'
                  AND parent_object_id = OBJECT_ID('arion.gbp_reply_draft')
                  AND definition NOT LIKE '%posting%')
BEGIN
  ALTER TABLE arion.gbp_reply_draft DROP CONSTRAINT CK_gbp_reply_draft_status;
  ALTER TABLE arion.gbp_reply_draft ADD CONSTRAINT CK_gbp_reply_draft_status
    CHECK (status IN ('held','posting','posted','skipped','stood_down','failed'));
  PRINT '  + gbp_reply_draft.status may be posting';
END
ELSE
  PRINT '  = gbp_reply_draft.status already allows posting (or the table is not here)';
GO

IF COL_LENGTH('arion.content_agent_output','held_reason') IS NULL
  ALTER TABLE arion.content_agent_output ADD held_reason NVARCHAR(40) NULL;
GO
IF COL_LENGTH('arion.content_agent_output','checks_json') IS NULL
  ALTER TABLE arion.content_agent_output ADD checks_json NVARCHAR(MAX) NULL;
GO
PRINT '  + content_agent_output: held_reason, checks_json';
GO

-- The job's price row, in the consolidated home.
IF OBJECT_ID('argus.action_pricing','U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM argus.action_pricing WHERE action_type = N'arion.review_reply')
BEGIN
  INSERT INTO argus.action_pricing (action_type, credits_per_call, description, outlier_cap_usd, is_active)
  SELECT N'arion.review_reply',
         COALESCE((SELECT credits_per_call FROM argus.action_pricing WHERE action_type = N'my_brand.review_reply'), 1),
         N'ARION: a reply to a Google review, written by your web person''s job. The same price as the Draft a reply button.',
         COALESCE((SELECT outlier_cap_usd FROM argus.action_pricing WHERE action_type = N'my_brand.review_reply'), 0.05),
         1;
  PRINT '  + argus.action_pricing arion.review_reply';
END
GO

-- And in the legacy home, for a database where the consolidation has not run.
IF OBJECT_ID('lumen.argus_action_pricing','U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM lumen.argus_action_pricing WHERE action_type = N'arion.review_reply')
BEGIN
  INSERT INTO lumen.argus_action_pricing (action_type, credits_per_call, description, outlier_cap_usd, is_active)
  SELECT N'arion.review_reply',
         COALESCE((SELECT credits_per_call FROM lumen.argus_action_pricing WHERE action_type = N'my_brand.review_reply'), 1),
         N'ARION: a reply to a Google review, written by your web person''s job. The same price as the Draft a reply button.',
         COALESCE((SELECT outlier_cap_usd FROM lumen.argus_action_pricing WHERE action_type = N'my_brand.review_reply'), 0.05),
         1;
  PRINT '  + lumen.argus_action_pricing arion.review_reply';
END
GO
