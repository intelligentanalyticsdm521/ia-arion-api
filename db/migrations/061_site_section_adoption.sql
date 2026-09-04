-- 061_site_section_adoption.sql
--
-- ARION website builder Phase 3 — adopting the sections that were built on
-- the website itself (SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.9, decision W-5).
--
-- WHAT THIS IS
--
-- Five client sites exist and not one section on them carries an `ia:` handle,
-- so the editor shows every one of them as "Custom section — built on the
-- site": in position, greyed, read-only, round-tripped byte for byte. That is
-- honest and it is also the reason those clients cannot change a word of their
-- own home page from the Portal.
--
-- Adoption is the offer to fix that one section at a time: read the section,
-- guess what kind it is, re-emit it through the ordinary adapter so the editor
-- can look after it, show the client BOTH before anything is written, and only
-- write on an explicit tap. Nothing is ever adopted automatically.
--
-- WHY THIS TABLE HAS TO EXIST — THE UNDO WINDOW
--
-- Adoption REPLACES a section's own Elementor layout with the standard layout
-- for its kind. That is a real, visible change to a live page, so it has to be
-- reversible, and "reversible" has to mean the ORIGINAL BYTES come back, not
-- something that looks similar.
--
-- The plugin already keeps an Undo ring (`_ia_page_snapshot`, IA_SNAPSHOT_MAX
-- = 20). It cannot carry this:
--   * it is WHOLE-PAGE, so restoring it would also throw away every edit made
--     after the adoption;
--   * it is 20 deep and SHARED with every ordinary save, so a client who edits
--     a headline twenty times has pushed the adopted-from bytes out of reach;
--   * it has no time window at all, and the Portal offers 30 days.
--
-- So the original top-level node is stored here verbatim, per adoption, and
-- "Undo adoption" splices exactly those bytes back at exactly that index. The
-- snapshot ring still fires on the write, as it does for every other save —
-- this is a second, narrower record, not a replacement.
--
-- NO CREDITS. The mapper is deterministic: widget signatures in, archetype
-- out. No model call, so no `argus.action_pricing` row and nothing to debit
-- (contrast 059, where the AI edit needed its pricing row or it would have
-- been dead on arrival).
--
-- Number 061 reserved in WORK_REGISTRY_2026-09-04 (062 stays spare).
-- Idempotent. Additive — safe to pre-apply before the code push
-- (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

PRINT '[061] ARION site builder Phase 3 — section adoption record';
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');
GO

IF OBJECT_ID('arion.site_section_adoption', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_section_adoption (
    adoption_id     UNIQUEIDENTIFIER NOT NULL
                    CONSTRAINT PK_arion_site_section_adoption PRIMARY KEY,
    tenant_id       UNIQUEIDENTIFIER NOT NULL,
    site_id         UNIQUEIDENTIFIER NOT NULL,        -- soft ref -> arion.site
    page_id         INT              NOT NULL,        -- the WordPress post id
    -- Where the section sat when it was adopted. Sections can be reordered
    -- afterwards, so Undo re-finds the section by its HANDLE first and falls
    -- back to this index only when the handle has gone.
    section_index   INT              NOT NULL,
    handle          NVARCHAR(200)    NOT NULL,        -- ia:<kind>:adopted:<blockId>
    kind            NVARCHAR(40)     NOT NULL,        -- hero | services | ...
    -- 0..1, two decimal places. Kept so "how well did the mapper do on real
    -- sites" is answerable from data rather than from memory.
    confidence      DECIMAL(4,3)     NOT NULL,
    -- The bytes that were on the page before. THE reason this table exists.
    original_json   NVARCHAR(MAX)    NOT NULL,
    -- What we put there instead, as written. Kept so an Undo can tell whether
    -- the section has been edited since (and say so) rather than silently
    -- discarding work.
    adopted_json    NVARCHAR(MAX)    NOT NULL,
    -- What the mapper could not carry over, as plain words. Empty for a clean
    -- adoption; an adoption is refused outright when any of it had content.
    unmapped_json   NVARCHAR(MAX)    NULL,
    actor_email     NVARCHAR(320)    NULL,
    status          NVARCHAR(12)     NOT NULL
                    CONSTRAINT DF_arion_site_section_adoption_status DEFAULT 'adopted',
    adopted_at      DATETIME2        NOT NULL
                    CONSTRAINT DF_arion_site_section_adoption_at DEFAULT SYSUTCDATETIME(),
    reverted_at     DATETIME2        NULL,
    CONSTRAINT CK_arion_site_section_adoption_status
      CHECK (status IN ('adopted', 'reverted')),
    CONSTRAINT CK_arion_site_section_adoption_confidence
      CHECK (confidence >= 0 AND confidence <= 1)
  );

  CREATE INDEX IX_arion_site_section_adoption_page
    ON arion.site_section_adoption (tenant_id, site_id, page_id, adopted_at DESC);
  CREATE INDEX IX_arion_site_section_adoption_handle
    ON arion.site_section_adoption (tenant_id, site_id, page_id, handle);

  PRINT '[061]   created arion.site_section_adoption';
END
ELSE
  PRINT '[061]   arion.site_section_adoption already exists';
GO

PRINT '[061] done';
GO
