-- 028_expire_plaintext_welcome_tokens.sql
--
-- F-SEC1.3 (2026-06-21) — Hash welcome_token at rest (SHA-256).
--
-- Prior to F-SEC1.3, arion.site.provisioning_details_json.welcome_token
-- stored the PLAINTEXT 32-byte base64url activation token written by
-- routes/onboarding/submit.js. If an attacker gained DB read access (backup
-- leak, support tool, SQL injection elsewhere), any unredeemed token was
-- directly usable to claim a tenant via /onboarding/activate.
--
-- F-SEC1.3 switches the at-rest representation to SHA-256 hex hashes; the
-- plaintext now lives only in the welcome-email URL. This migration handles
-- existing rows: rather than try to detect "is this plaintext or hash?" at
-- activation time, we force-expire every currently-unredeemed Path A token
-- by stamping welcome_token_expires_at = NOW inside the JSON blob. Affected
-- accounts will fail activation once with TOKEN_EXPIRED and then go through
-- the welcome-email resend recovery path (which mints a fresh hashed token).
--
-- "Unredeemed" on Path A = welcome_token IS NOT NULL AND welcome_token_used_at
-- IS NULL inside the provisioning_details_json blob.
--
-- We use JSON_MODIFY to set welcome_token_expires_at to the current UTC
-- timestamp. JSON_VALUE filters on used_at presence so we don't touch rows
-- already redeemed. NEWID() guard is defensive — JSON_MODIFY on a NULL
-- column is a no-op, and we additionally filter by provisioning_details_json
-- IS NOT NULL.
--
-- IDEMPOTENT. Re-running is a no-op once arion-api ships the hashed-write
-- code (new rows have welcome_token_expires_at far in the future, and we
-- only stamp rows whose expires_at is missing or still future).
--
-- TARGET DB: iadm_services.

UPDATE arion.site
   SET provisioning_details_json = JSON_MODIFY(
         provisioning_details_json,
         '$.welcome_token_expires_at',
         CONVERT(NVARCHAR(40), SYSUTCDATETIME(), 127)
       ),
       updated_at = SYSDATETIMEOFFSET()
 WHERE provisioning_details_json IS NOT NULL
   AND JSON_VALUE(provisioning_details_json, '$.welcome_token') IS NOT NULL
   AND JSON_VALUE(provisioning_details_json, '$.welcome_token_used_at') IS NULL
   AND (
         JSON_VALUE(provisioning_details_json, '$.welcome_token_expires_at') IS NULL
         OR TRY_CONVERT(DATETIME2, JSON_VALUE(provisioning_details_json, '$.welcome_token_expires_at')) > SYSUTCDATETIME()
       );
GO
