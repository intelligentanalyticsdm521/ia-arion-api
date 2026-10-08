-- 072_plain_words_for_credit_prices.sql
--
-- Plain words on the credit price list (fixer pass, 2026-10-08). The
-- description of each priced action is printed on an owner's page (Settings
-- -> ARGUS data plan, beside the action), and the seeded descriptions named
-- the model behind it, its size class, our own cost per call, and "Agent".
-- An owner reads what the action does for them, not which model does it.
--
-- One UPDATE per action type, in BOTH pricing homes (argus.action_pricing and
-- lumen.argus_action_pricing, the two homes 071 writes; the 065 rule).
-- GUARDED: a row is changed only while its description still names a model
-- or a size class, so a description somebody has since rewritten by hand is
-- left alone, and running this twice changes nothing the second time.
-- The descriptions were read from the dev rows on 2026-10-08 (18 per home).
-- A row this file does not list is counted and printed, never guessed at.
--
-- NOTHING HERE BELONGS TO ONE BUSINESS: these are platform price rows.
-- Idempotent; safe to pre-apply before the code push.
--
-- TARGET DB: iadm_services.

IF OBJECT_ID('argus.action_pricing','U') IS NOT NULL
BEGIN
  UPDATE argus.action_pricing SET description = N'ARION: a blog post written in your voice, on the topic picked for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.content_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION: a check of a draft for quality, and for anything that should wait for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.content_quality_scan' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION: a reply to a Google review, written by your web person''s job. The same price as the Draft a reply button.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.review_reply' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION website builder: changes a whole page from your instruction, and may suggest new sections. Nothing reaches your site until you approve it.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_edit_page' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION website builder: rewrites one section from your instruction. Nothing reaches your site until you approve it.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_edit_section' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION website builder: writes one new section for your business, saved as a draft you keep or discard. A layout taken from the ready-made section library is not charged.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_generate_section' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION: the words for a social post, in your voice.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.social_copy' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'ARION: picks what to write about next, from what your customers search for.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.topic_selection' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'A second look at one of ARGUS''s decisions. Never charged to you: 0 credits.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'il.judge' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'My Brand: a drafted reply to a Google review, in your voice.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'my_brand.review_reply' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'Design Studio: Write it for me, with three versions to pick from.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'my_brand.write_assist' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'OLIVER: Ask ARGUS in the document builder drafts or rewrites a section.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'oliver.builder_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'OLIVER: a follow-up about a quote or a payment, drafted for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'oliver.qtc_agent_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'SPARK: an email or text campaign, or a win-back batch, drafted for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.campaign_agent_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'SPARK: a check of a campaign draft for quality, and for anything that should wait for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.campaign_agent_scan' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'SPARK: reads a new inquiry to see what it is about.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_classify' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'SPARK: a reply to a new inquiry, drafted from your business details.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE argus.action_pricing SET description = N'SPARK: a quote note drafted from your price list. Prices come from your price list, never from the writer.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_quote_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  DECLARE @left INT = (SELECT COUNT(*) FROM argus.action_pricing WHERE (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%'));
  PRINT CONCAT('  = argus.action_pricing: ', @left, ' description(s) still name a model (an action type this file does not list)');
END
ELSE
  PRINT '  = argus.action_pricing is not here';
GO

IF OBJECT_ID('lumen.argus_action_pricing','U') IS NOT NULL
BEGIN
  UPDATE lumen.argus_action_pricing SET description = N'ARION: a blog post written in your voice, on the topic picked for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.content_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION: a check of a draft for quality, and for anything that should wait for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.content_quality_scan' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION: a reply to a Google review, written by your web person''s job. The same price as the Draft a reply button.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.review_reply' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION website builder: changes a whole page from your instruction, and may suggest new sections. Nothing reaches your site until you approve it.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_edit_page' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION website builder: rewrites one section from your instruction. Nothing reaches your site until you approve it.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_edit_section' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION website builder: writes one new section for your business, saved as a draft you keep or discard. A layout taken from the ready-made section library is not charged.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.site_generate_section' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION: the words for a social post, in your voice.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.social_copy' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'ARION: picks what to write about next, from what your customers search for.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'arion.topic_selection' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'A second look at one of ARGUS''s decisions. Never charged to you: 0 credits.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'il.judge' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'My Brand: a drafted reply to a Google review, in your voice.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'my_brand.review_reply' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'Design Studio: Write it for me, with three versions to pick from.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'my_brand.write_assist' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'OLIVER: Ask ARGUS in the document builder drafts or rewrites a section.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'oliver.builder_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'OLIVER: a follow-up about a quote or a payment, drafted for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'oliver.qtc_agent_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'SPARK: an email or text campaign, or a win-back batch, drafted for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.campaign_agent_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'SPARK: a check of a campaign draft for quality, and for anything that should wait for you.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.campaign_agent_scan' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'SPARK: reads a new inquiry to see what it is about.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_classify' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'SPARK: a reply to a new inquiry, drafted from your business details.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  UPDATE lumen.argus_action_pricing SET description = N'SPARK: a quote note drafted from your price list. Prices come from your price list, never from the writer.', updated_at = SYSUTCDATETIME()
   WHERE action_type = N'spark.responder_quote_draft' AND (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%');
  DECLARE @left INT = (SELECT COUNT(*) FROM lumen.argus_action_pricing WHERE (description LIKE N'%Claude%' OR description LIKE N'%Sonnet%' OR description LIKE N'%Haiku%' OR description LIKE N'%GPT%' OR description LIKE N'%class%'));
  PRINT CONCAT('  = lumen.argus_action_pricing: ', @left, ' description(s) still name a model (an action type this file does not list)');
END
ELSE
  PRINT '  = lumen.argus_action_pricing is not here';
GO
