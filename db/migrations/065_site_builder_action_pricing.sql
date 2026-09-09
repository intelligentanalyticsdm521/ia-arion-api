-- 065_site_builder_action_pricing.sql
--
-- ARION pack 1 (2026-09-08) — ONE PRICE LIST for the AI Builder's own two
-- actions (P18, GAP_ANALYSIS_2026-09-08 ARION "One price, one source").
--
-- WHAT WAS WRONG
--
-- The AI Builder page carried its own credit arithmetic, client side, with the
-- TODO still on it:
--
--     // TODO F-Onb-D10: move COSTS + BLOCK_DEFAULTS into a
--     //                 GET /arion/ai-builder/pricing endpoint so DB is
--     //                 source of truth.
--     export const SECTION_COSTS = { base: 2, perColumn: 3, perItem: 2,
--                                    imageStd: 8, imageHd: 16, form: 5 };
--     (Portal src/arion/pages/website/WebsiteAiBuilder.tsx:17-27)
--
-- ...and the server charged NONE of it: `grep meterAndAudit routes/arion/blocks.js`
-- was zero hits. Generating a section quoted "from 8 credits" and debited
-- nothing; `lib/websiteBuilder/costGuard.js` enforced a dollar ceiling the
-- client was never shown. Three answers to "what does this cost" in one
-- feature, none of them the one that ran (feedback_no_fabricated_catalog).
--
-- WHAT THIS DOES
--
-- Adds the two rows so the code can read a price instead of inventing one:
--
--   arion.site_generate_section   2 credits   one section's copy written from
--                                             scratch (Haiku-class, ~1500
--                                             output tokens, ~$0.008/call).
--                                             Six of the eight archetypes are
--                                             usually answered out of the
--                                             curated section library with NO
--                                             model call, and the route charges
--                                             nothing for those — a library
--                                             answer is free and says so.
--
--   arion.site_assemble_page      0 credits   putting accepted sections onto a
--                                             page and publishing them. No
--                                             model call happens, so it costs
--                                             nothing — and the ZERO is a ROW
--                                             rather than the word "free"
--                                             hardcoded in the UI. Change this
--                                             row and the code charges it
--                                             (routes/arion/blocks.js reads
--                                             `afford.credits`).
--
-- outlier_cap_usd is ~5x the expected provider cost: high enough never to trip
-- on a normal call, low enough that one runaway call is flagged credit-neutral.
-- Same arithmetic as 059's two rows.
--
-- ⚠ BOTH PRICING HOMES, DELIBERATELY
--
-- `src/lib/argus/tables.js` resolves the pricing table to `argus.action_pricing`
-- as soon as `argus.credit_grant` exists, and to `lumen.argus_action_pricing`
-- before that. Migration 132 (the consolidation) runs BEFORE the migrations
-- that seeded the SPARK campaign agent's and the ARION content agent's prices
-- into the legacy home only, and never copied them forward — so in every
-- database where 132 has run, those two agents get `unknown_action` from
-- meterAndAudit and cannot draft at all. That is the POC-blocking defect the
-- ARGUS reader found on 2026-09-08. A row seeded into one home is a row that
-- disappears at consolidation, so this writes BOTH, exactly as LUMEN's
-- 153_responder.sql does.
--
-- Number 065 reserved in WORK_REGISTRY_2026-09-04 (2026-09-08, ARION pack 1).
-- Seed only — no schema change. Idempotent: re-running changes nothing.
-- Additive, so it is safe to pre-apply before the code push
-- (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

PRINT '[065] ARION site builder - AI Builder action pricing (generate + assemble)';
GO

/* ---------------------------------------------------------------------------
 * The rows, written into whichever of the two homes exist. Dynamic SQL because
 * a hard reference to a table that does not exist in this database will not
 * compile, even inside an IF that is false.
 * ------------------------------------------------------------------------- */

DECLARE @homes TABLE (name SYSNAME);

IF OBJECT_ID('argus.action_pricing', 'U') IS NOT NULL
  INSERT INTO @homes (name) VALUES (N'argus.action_pricing');

IF OBJECT_ID('lumen.argus_action_pricing', 'U') IS NOT NULL
  INSERT INTO @homes (name) VALUES (N'lumen.argus_action_pricing');

IF NOT EXISTS (SELECT 1 FROM @homes)
BEGIN
  -- Neither table exists (a database that has never had ARGUS). Say so loudly
  -- rather than pretending the feature is priced: an unpriced action is DEAD,
  -- not free — meterAndAudit answers `unknown_action` and the route refuses.
  PRINT '[065]   !! no action-pricing table found - the AI Builder will refuse both actions until LUMEN''s ARGUS migrations are applied';
END
ELSE
BEGIN
  DECLARE @home SYSNAME, @sql NVARCHAR(MAX);
  DECLARE home_cur CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @homes;
  OPEN home_cur;
  FETCH NEXT FROM home_cur INTO @home;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    SET @sql = N'
      IF NOT EXISTS (SELECT 1 FROM ' + @home + N' WHERE action_type = N''arion.site_generate_section'')
        INSERT INTO ' + @home + N' (action_type, credits_per_call, description, outlier_cap_usd, is_active)
        VALUES (N''arion.site_generate_section'', 2,
                N''ARION website builder - write one section from scratch for this business (Claude Haiku 4.5). Saved as a draft the client accepts or discards; a layout answered from the curated section library runs no model and is not charged. ~$0.008/call.'',
                0.05, 1);

      IF NOT EXISTS (SELECT 1 FROM ' + @home + N' WHERE action_type = N''arion.site_assemble_page'')
        INSERT INTO ' + @home + N' (action_type, credits_per_call, description, outlier_cap_usd, is_active)
        VALUES (N''arion.site_assemble_page'', 0,
                N''ARION website builder - put the sections a client has accepted onto a page and publish them. No model call, so no charge; the zero lives here rather than as the word "free" in the Portal.'',
                0.05, 1);';
    EXEC sp_executesql @sql;
    PRINT '[065]   pricing rows present in ' + @home + ' (arion.site_generate_section 2cr, arion.site_assemble_page 0cr)';
    FETCH NEXT FROM home_cur INTO @home;
  END
  CLOSE home_cur;
  DEALLOCATE home_cur;
END
GO

PRINT '[065] DONE.';
GO
