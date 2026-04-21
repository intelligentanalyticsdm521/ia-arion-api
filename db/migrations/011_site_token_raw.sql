-- Migration 011: Store raw site_token for outbound ARION → Plugin calls.
--
-- Background: arion.site.site_token_hash stores SHA-256 of the token for
-- INCOMING verification (plugin → ARION webhooks). For OUTBOUND calls
-- (ARION pulling data from the plugin) we need to send the raw token in
-- the X-Arion-Site-Token header, which requires ARION to have the raw
-- value. Until now we've been using WP application password Basic auth,
-- but that requires clients to manually create an app password in WP
-- admin. The plugin-provided site_token is zero-config and already tied
-- to our provisioning flow.
--
-- Security posture: Azure SQL Transparent Data Encryption (TDE) protects
-- the column at rest. This is the same model used by Stripe/Twilio/etc
-- for platform API keys — the raw value lives in our database but the DB
-- itself is encrypted. Clients cannot access this column (no direct SQL
-- access is granted to anyone outside IA).
--
-- Prerequisite: migrations 001-010 applied.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'site_token_raw' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD site_token_raw NVARCHAR(256) NULL;
GO

PRINT 'Migration 011 applied: arion.site.site_token_raw column added.';
