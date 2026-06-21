-- Migration 025: arion.site_block_draft — record which WP post a draft was injected into.
--
-- Phase 2 of the ARION IL website builder (page assembler) needs to remember,
-- per draft block:
--   - which WP page it was concatenated onto (persisted_to_post_id)
--   - when that injection happened (persisted_at)
--
-- After a successful assemble + inject we mark the draft accepted=1 + stamp
-- these fields. Re-running the assembler updates persisted_to_post_id to the
-- latest target page (drafts can be re-used across pages on demand).
--
-- Idempotent. Safe to re-run.
--
-- References:
--   db/migrations/024_ai_website_builder.sql (the parent table)
--   lib/websiteBuilder/pageAssembler.js + wpInjector.js
--   routes/arion/blocks.js (will be extended with POST /assemble in same batch)

IF NOT EXISTS (SELECT 1 FROM sys.columns
                WHERE Name = N'persisted_to_post_id'
                  AND Object_ID = OBJECT_ID(N'arion.site_block_draft'))
BEGIN
  ALTER TABLE arion.site_block_draft ADD persisted_to_post_id INT NULL;
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns
                WHERE Name = N'persisted_at'
                  AND Object_ID = OBJECT_ID(N'arion.site_block_draft'))
BEGIN
  ALTER TABLE arion.site_block_draft ADD persisted_at DATETIME2 NULL;
END;

PRINT 'Migration 025 applied: arion.site_block_draft.persisted_to_post_id + persisted_at columns added.';
