-- 074_room_for_sealed_google_tokens.sql
--
-- Room for the sealed Google refresh token (security finding, 2026-10-08).
-- arion.site.gbp_oauth_token_ref held the Google refresh token in clear text.
-- lib/gbpTokenAtRest.js now stores it sealed (AES-256-GCM) once the server holds
-- its key, as enc:v1:<iv>:<tag>:<ciphertext>. A sealed value is about 4/3 the
-- token's length plus 50 characters, which a 200-character column fits only
-- for today's short tokens. Both token columns widen to 1000 characters.
--
-- Widening an NVARCHAR column keeps every value as it is; nothing is rewritten.
-- GUARDED: each column is altered only while it is narrower than 1000, so
-- running this twice changes nothing the second time. The last statement
-- SELECTs both widths (in characters) so the pipeline log shows 1000 and 1000.
--
-- NOTHING HERE BELONGS TO ONE BUSINESS. Safe to pre-apply before the code push.
--
-- TARGET DB: iadm_services.

IF COL_LENGTH('arion.site', 'gbp_oauth_token_ref') IS NOT NULL
   AND COL_LENGTH('arion.site', 'gbp_oauth_token_ref') < 2000
    ALTER TABLE arion.site ALTER COLUMN gbp_oauth_token_ref NVARCHAR(1000) NULL;

IF COL_LENGTH('arion.site', 'gsc_oauth_token_ref') IS NOT NULL
   AND COL_LENGTH('arion.site', 'gsc_oauth_token_ref') < 2000
    ALTER TABLE arion.site ALTER COLUMN gsc_oauth_token_ref NVARCHAR(1000) NULL;

SELECT COL_LENGTH('arion.site', 'gbp_oauth_token_ref') / 2 AS gbp_token_chars,
       COL_LENGTH('arion.site', 'gsc_oauth_token_ref') / 2 AS gsc_token_chars;
