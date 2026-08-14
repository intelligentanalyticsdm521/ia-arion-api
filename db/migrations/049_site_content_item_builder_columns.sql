-- 049_site_content_item_builder_columns.sql
--
-- Plugin v1.4.0 columns for arion.site_content_item.
--
-- WHY: word_count was WRONG on every page-builder site. Elementor leaves
-- post_content empty and keeps the real copy in the _elementor_data meta blob,
-- so the plugin's `str_word_count( post_content )` returned 0 for pages that
-- carry 1,200 words. On intelligentanalyticsdm.com that was 13 of 115 pages --
-- including the best articles on the site. The Content Library report reads
-- word_count to decide what is "thin", so it was about to tell the owner to go
-- and expand the pages they should have been proudest of.
--
-- Plugin v1.4.0 fixes the count and, since it now has the parsed content in
-- hand, reports two more things a consultant checks on every page:
--
--   content_source  where the copy actually lives (elementor | blocks | classic).
--                   Worth storing rather than deriving: it explains a jump in
--                   word_count on the night the fix lands, and it is the honest
--                   answer to "why does this page read as empty".
--   h1/h2/h3 counts the on-page structure staple. Zero H1s, or several, is a
--                   real finding; before v1.4.0 every builder site reported
--                   none at all because the levels live in header_size, not <hN>.
--
-- Additive and nullable: rows captured before v1.4.0 keep their NULLs, which is
-- correct -- we did not know, and back-filling a guess would be worse.

IF COL_LENGTH('arion.site_content_item', 'content_source') IS NULL
  ALTER TABLE arion.site_content_item ADD content_source NVARCHAR(20) NULL;
GO

IF COL_LENGTH('arion.site_content_item', 'h1_count') IS NULL
  ALTER TABLE arion.site_content_item ADD h1_count INT NULL;
GO

IF COL_LENGTH('arion.site_content_item', 'h2_count') IS NULL
  ALTER TABLE arion.site_content_item ADD h2_count INT NULL;
GO

IF COL_LENGTH('arion.site_content_item', 'h3_count') IS NULL
  ALTER TABLE arion.site_content_item ADD h3_count INT NULL;
GO
