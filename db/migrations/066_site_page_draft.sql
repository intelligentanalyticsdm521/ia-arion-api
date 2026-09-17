-- 066_site_page_draft.sql
--
-- BUILDER_USER_TEST_2026-09-16 D-05, the most dangerous single behaviour the
-- walk found:
--
--   "Save draft on a LIVE page took the home page off the internet. No
--    warning, no confirmation. The header flipped from Home · Live to
--    Home · Draft, the page moved into 'Drafts — Nobody can see these until
--    you publish them', and http://localhost:8084/home/ started returning 404."
--
-- WHY IT HAPPENED. There was nowhere for an unpublished change to live. The
-- only two states a page could be in were WordPress's own `draft` and
-- `publish`, so "save without publishing" could only be spelled as "make the
-- whole page a draft" — which is the same wire as "take it off the internet".
--
-- WHAT THIS IS. One row per page that has unpublished changes: the sections the
-- author last saved, held BESIDE the live version rather than on top of it. The
-- live page keeps its bytes, its snapshots and its Undo ring; the public URL
-- never moves. Publishing writes the draft through the ordinary save path and
-- deletes the row; discarding just deletes the row.
--
-- ONE ROW PER PAGE, ON PURPOSE. This is "the work in progress", not a version
-- history — the plugin's snapshot ring already answers "what did this page look
-- like before", and a second history would be a second mechanism for the same
-- question (feedback_think_holistically).
--
-- Number 066 follows 065 (site_builder_action_pricing). Idempotent. Additive —
-- safe to pre-apply before the code push (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

PRINT '[066] ARION website builder — an unpublished draft beside a live page (D-05)';
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');
GO

IF OBJECT_ID('arion.site_page_draft', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_page_draft (
    tenant_id     UNIQUEIDENTIFIER NOT NULL,
    site_id       UNIQUEIDENTIFIER NOT NULL,
    page_id       INT              NOT NULL,
    -- The Portal's own section list, exactly as a save would have sent it.
    -- Stored verbatim: this is the author's work, and re-deriving it on the way
    -- in is how a draft comes back different from what was typed.
    sections_json NVARCHAR(MAX)    NOT NULL,
    title         NVARCHAR(400)    NULL,
    saved_at      DATETIME2(3)     NOT NULL CONSTRAINT DF_arion_site_page_draft_saved_at DEFAULT SYSUTCDATETIME(),
    saved_by      NVARCHAR(320)    NULL,
    CONSTRAINT PK_arion_site_page_draft PRIMARY KEY (tenant_id, site_id, page_id)
  );
  PRINT '[066]   created arion.site_page_draft';
END
ELSE
BEGIN
  PRINT '[066]   arion.site_page_draft already exists';
END
GO

PRINT '[066] done';
GO
