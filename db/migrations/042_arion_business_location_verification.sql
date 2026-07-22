-- 042_arion_business_location_verification.sql — GBP Connect Batch B
-- ---------------------------------------------------------------------------
-- The "I need one created" flow creates a brand-new GBP listing on the
-- CLIENT'S token (client = PRIMARY_OWNER) and then drives Google's My
-- Business Verifications API from inside ARION: fetch options → request
-- verification → complete with PIN → poll VoiceOfMerchantState. The portal
-- needs to track WHERE in that flow a listing is across sessions — a mailed
-- postcard PIN arrives days later — so the state lives on the listing row.
--
--   verification_method       chosen option (PHONE_CALL / SMS / EMAIL /
--                             ADDRESS / AUTO / VETTED_PARTNER)
--   verification_name         Google resource "locations/{l}/verifications/{v}"
--                             — required to complete with the PIN later
--   verification_state        our last-known Google state (PENDING /
--                             COMPLETED / FAILED; UNVERIFIED before any
--                             request). is_verified (migration 027 + T5)
--                             stays THE authoritative bit, flipped only on
--                             hasVoiceOfMerchant === true — fail-closed.
--   verification_requested_at when the request was submitted
--
-- Idempotent (COL_LENGTH guards). Safe to re-run.
--
-- References:
--   lib/gbpVerifications.js                      (writer via routes)
--   routes/arion.js (/sites/:siteId/gbp/create-listing, /verification-*)
--   db/migrations/027_arion_business_location.sql (target table, is_verified)
--
-- 2026-07-22

IF COL_LENGTH('arion.business_location', 'verification_method') IS NULL
BEGIN
  ALTER TABLE arion.business_location ADD verification_method NVARCHAR(40) NULL;
END;
GO

IF COL_LENGTH('arion.business_location', 'verification_name') IS NULL
BEGIN
  ALTER TABLE arion.business_location ADD verification_name NVARCHAR(300) NULL;
END;
GO

IF COL_LENGTH('arion.business_location', 'verification_state') IS NULL
BEGIN
  ALTER TABLE arion.business_location ADD verification_state NVARCHAR(40) NULL;
END;
GO

IF COL_LENGTH('arion.business_location', 'verification_requested_at') IS NULL
BEGIN
  ALTER TABLE arion.business_location ADD verification_requested_at DATETIMEOFFSET NULL;
END;
GO

PRINT 'Migration 042 applied: arion.business_location verification-state columns.';
