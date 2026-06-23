-- 034_arion_site_google_bing_setup.sql
-- TARGET DB: iadm_services (arion schema)
--
-- Adds the columns the new Google/Bing dual-path onboarding flow writes
-- (routes/onboarding/google-oauth.js + the bing-setup-mode runner step).
-- Brandon's locked design (2026-06-23 evening):
--
--   User picks one of three answers up front:
--     YES        — they already have GA4/GSC/GBP under their own Google
--                   account. Run the existing OAuth path. setup_mode = 'byo'.
--     NO         — they have nothing. IA service-account provisions GA4
--                   property + GSC site + GBP listing under the IA master
--                   Google account, then invites the customer as Admin /
--                   adds the customer's email to GA4 property access etc.
--                   setup_mode = 'ia_managed'.
--     NOT_SURE   — IA probes via the master service account: lists all GSC
--                   sites the IA principal already has on the domain, calls
--                   GBP search-listings for the domain, queries the GA4
--                   property pool for the domain hostname. If anything is
--                   found, hand the customer over to YES path. Else NO path.
--                   setup_mode is recorded as 'auto_byo' or 'auto_ia'
--                   depending on which branch the probe routed to.
--
-- Same shape for Bing — the user picks BYO vs auto-create-under-IA, and
-- the existing master-account auto-connect path (POST /arion/bing/auto-connect)
-- already covers IA-provisioned with ownership transfer via Bing's
-- AddSiteRoles invitation API (separate small impl alongside this migration).
--
-- All ADDs are idempotent (IF COL_LENGTH IS NULL) so the migration is safe
-- to re-run and lower environments without column-add privileges can fall
-- back to the runtime IF COL_LENGTH() guards in the route handlers.

IF COL_LENGTH('arion.site', 'google_setup_mode') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD google_setup_mode NVARCHAR(20) NULL;        -- byo | ia_managed | auto_byo | auto_ia | pending
END
GO

IF COL_LENGTH('arion.site', 'google_setup_probed_at') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD google_setup_probed_at DATETIMEOFFSET NULL;
END
GO

IF COL_LENGTH('arion.site', 'google_setup_evidence_json') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD google_setup_evidence_json NVARCHAR(MAX) NULL;
END
GO

IF COL_LENGTH('arion.site', 'google_ownership_transferred_at') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD google_ownership_transferred_at DATETIMEOFFSET NULL;
END
GO

IF COL_LENGTH('arion.site', 'google_managed_account_id') IS NULL
BEGIN
  -- The IA-master account_id (GBP accounts/<id>) under which the listing
  -- lives BEFORE transfer. Kept post-transfer for audit + retry.
  ALTER TABLE arion.site
    ADD google_managed_account_id NVARCHAR(80) NULL;
END
GO

IF COL_LENGTH('arion.site', 'bing_setup_mode') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD bing_setup_mode NVARCHAR(20) NULL;          -- byo | ia_managed | auto_byo | auto_ia | pending
END
GO

IF COL_LENGTH('arion.site', 'bing_setup_probed_at') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD bing_setup_probed_at DATETIMEOFFSET NULL;
END
GO

IF COL_LENGTH('arion.site', 'bing_ownership_transferred_at') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD bing_ownership_transferred_at DATETIMEOFFSET NULL;
END
GO

-- Founder dashboard: surface sites where the IA master path is partway
-- through ownership transfer (provisioned but no transferred_at yet).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_arion_site_google_ia_pending_transfer')
CREATE INDEX IX_arion_site_google_ia_pending_transfer
  ON arion.site (tenant_id, google_setup_mode, google_ownership_transferred_at)
  WHERE google_setup_mode IN ('ia_managed', 'auto_ia')
    AND google_ownership_transferred_at IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_arion_site_bing_ia_pending_transfer')
CREATE INDEX IX_arion_site_bing_ia_pending_transfer
  ON arion.site (tenant_id, bing_setup_mode, bing_ownership_transferred_at)
  WHERE bing_setup_mode IN ('ia_managed', 'auto_ia')
    AND bing_ownership_transferred_at IS NULL;
GO
