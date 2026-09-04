-- 059_site_edit_proposal.sql
--
-- ARION website builder Phase 1B — "tell the AI what you want, preview,
-- approve" (SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.8, decisions W-3/W-4).
--
-- WHAT THIS IS
--
-- The AI never writes to a client's website. It PROPOSES a new set of field
-- values for one section (or for a whole page), that proposal is stored here,
-- and the client sees a before/after and taps Approve or Discard. Approving
-- runs the ordinary save path — same snapshot, same publish control — so
-- Undo covers an AI edit exactly as it covers a typed one. That is the
-- Content agent's own locked rule (project_arion_content_agent: code
-- generation is PROPOSE-ONLY) applied to page content.
--
-- The row exists so that:
--   1. nothing is written to the site until a human taps Approve;
--   2. the credits a proposal cost are recorded even when it is discarded
--      (the model call happened — discarding does not refund it, and the
--      client can see what they paid for);
--   3. "what did the AI change on my website" is answerable after the fact.
--
-- Number 059 reserved in WORK_REGISTRY_2026-09-04 (060 stays spare).
-- Idempotent. Additive — safe to pre-apply before the code push
-- (feedback_migrations_before_code_push).
--
-- TARGET DB: iadm_services.

PRINT '[059] ARION site builder 1B — proposals + AI action pricing';
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');
GO

IF OBJECT_ID('arion.site_edit_proposal', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_edit_proposal (
    proposal_id      UNIQUEIDENTIFIER NOT NULL
                     CONSTRAINT PK_arion_site_edit_proposal PRIMARY KEY,
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,          -- soft ref -> arion.site
    page_id          INT              NOT NULL,          -- the WordPress post id
    scope            NVARCHAR(10)     NOT NULL,          -- 'section' | 'page'
    -- Which section the proposal is about. NULL for a page-scoped proposal.
    -- The handle is `ia:<kind>:<blueprint>:<blockId>` and is NOT unique on a
    -- page (two heroes share one), so the index is carried alongside it.
    section_handle   NVARCHAR(200)    NULL,
    section_index    INT              NULL,
    section_kind     NVARCHAR(40)     NULL,
    instruction      NVARCHAR(2000)   NOT NULL,          -- what the client typed
    before_json      NVARCHAR(MAX)    NOT NULL,          -- field values as they are now
    after_json       NVARCHAR(MAX)    NOT NULL,          -- field values the model proposed
    diff_plain       NVARCHAR(MAX)    NULL,              -- plain-words summary, one line per change
    status           NVARCHAR(12)     NOT NULL
                     CONSTRAINT DF_arion_site_edit_proposal_status DEFAULT 'proposed',
    credits_charged  INT              NULL,              -- what ARGUS actually debited
    model            NVARCHAR(64)     NULL,              -- internal only; never shown to a client
    actor_email      NVARCHAR(320)    NULL,
    created_at       DATETIME2        NOT NULL
                     CONSTRAINT DF_arion_site_edit_proposal_created DEFAULT SYSUTCDATETIME(),
    resolved_at      DATETIME2        NULL,              -- stamped on applied / discarded
    CONSTRAINT CK_arion_site_edit_proposal_scope
      CHECK (scope IN ('section', 'page')),
    CONSTRAINT CK_arion_site_edit_proposal_status
      CHECK (status IN ('proposed', 'applied', 'discarded'))
  );

  CREATE INDEX IX_arion_site_edit_proposal_page
    ON arion.site_edit_proposal (tenant_id, site_id, page_id, created_at DESC);
  CREATE INDEX IX_arion_site_edit_proposal_status
    ON arion.site_edit_proposal (tenant_id, status, created_at DESC);

  PRINT '[059]   created arion.site_edit_proposal';
END
ELSE
  PRINT '[059]   arion.site_edit_proposal already exists';
GO

-- ---------------------------------------------------------------------------
-- ARGUS action pricing for the two AI edits.
--
-- WHY THIS IS HERE AND NOT IN A LUMEN MIGRATION
--
-- lumen.argus_action_pricing / argus.action_pricing is LUMEN's table, and the
-- pricing rows for other features live in LUMEN migrations. But meterAndAudit
-- calls getActionPricing FIRST and returns `unknown_action` when no row
-- matches, so an action without a row is not "unmetered" — it is DEAD, every
-- call fails. That is exactly the failure LUMEN 130 had to clean up: eight AI
-- features whose pricing rows existed only in dev, hand-inserted, all 503ing
-- in production while looking fine locally. Shipping the row in the same pass
-- as the feature is the fix for that class of bug, and this branch owns
-- arion 059, not a LUMEN number. Same database, so the INSERT lands in the
-- same place either way.
--
-- Both table names are handled, exactly as lib/argus/tables.js does: the
-- consolidated name (LUMEN 132) when argus.credit_grant exists, the legacy
-- name otherwise. Writing only one of them would leave the feature dead on
-- whichever side of the consolidation the environment is on.
--
-- CREDIT SIZING — derived from the matrix rather than invented. Implied rate
-- across existing rows is ~$0.0075 per credit (LUMEN 149 shows the working).
--
--   arion.site_edit_section — Claude Haiku 4.5, ~3K in + ~800 out
--       (3000/1e6 * 1) + (800/1e6 * 5) = $0.003 + $0.004 = $0.007  -> 1 credit
--     Rewriting the fields of ONE section to a plain-English instruction is a
--     constrained transform over text that already exists, not open creative
--     writing. The Haiku class anchors at 1 credit across the whole matrix
--     (LUMEN 123 / 125 / 129 / 149) and this sits exactly on that anchor.
--
--   arion.site_edit_page — Claude Sonnet 5, ~6K in + ~2K out
--       (6000/1e6 * 3) + (2000/1e6 * 15) = $0.018 + $0.030 = $0.048 -> 6 credits
--     A page-level instruction ("make the tone warmer", "add a section about
--     winter services") reads every section on the page and may propose a new
--     one, so it gets the bigger model and is priced for it.
--
-- Sonnet 5 is priced at the STANDARD $3/$15 per million, never the expired
-- promotional rate, matching callWrapper.js PROVIDER_COSTS so margin is never
-- overstated.
--
-- outlier_cap_usd is ~5x expected cost: high enough never to trip on a normal
-- call, low enough that one runaway call is flagged credit-neutral.
-- ---------------------------------------------------------------------------

DECLARE @pricing SYSNAME =
  CASE WHEN OBJECT_ID('argus.action_pricing', 'U') IS NOT NULL
       THEN N'argus.action_pricing'
       ELSE N'lumen.argus_action_pricing' END;

IF OBJECT_ID(@pricing, 'U') IS NULL
BEGIN
  -- Neither table exists (a database that has never had ARGUS). Say so
  -- loudly rather than pretending the feature is priced.
  PRINT '[059]   !! no action-pricing table found — AI edits will return unknown_action until LUMEN''s ARGUS migrations are applied';
END
ELSE
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'
    IF NOT EXISTS (SELECT 1 FROM ' + @pricing + N' WHERE action_type = N''arion.site_edit_section'')
      INSERT INTO ' + @pricing + N' (action_type, credits_per_call, description, outlier_cap_usd, is_active)
      VALUES (N''arion.site_edit_section'', 1,
              N''ARION website builder — rewrite one section from a plain-English instruction (Claude Haiku 4.5). Proposal only; nothing reaches the site until the client approves. ~$0.007/call.'',
              0.05, 1);

    IF NOT EXISTS (SELECT 1 FROM ' + @pricing + N' WHERE action_type = N''arion.site_edit_page'')
      INSERT INTO ' + @pricing + N' (action_type, credits_per_call, description, outlier_cap_usd, is_active)
      VALUES (N''arion.site_edit_page'', 6,
              N''ARION website builder — page-level instruction across every section, may propose new sections (Claude Sonnet 5). Proposal only; nothing reaches the site until the client approves. ~$0.048/call.'',
              0.25, 1);';
  EXEC sp_executesql @sql;
  PRINT '[059]   action pricing rows present in ' + @pricing + ' (arion.site_edit_section 1cr, arion.site_edit_page 6cr)';
END
GO

PRINT '[059] DONE.';
GO
