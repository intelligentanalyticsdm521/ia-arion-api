-- 035_arion_site_gsc_site_url.sql
-- TARGET DB: iadm_services (arion schema)
--
-- Adds the gsc_site_url column to arion.site. This column is the canonical
-- Google Search Console site URL (sc-domain: form for domain properties, or
-- the https://host/ URL form for URL-prefix properties) and is required by
-- the runner's GSC ingest path, the intelligence rebuild path, and the
-- google-oauth IA-managed mirror UPDATE.
--
-- Existing call sites that read/write this column:
--   - routes/arion/intelligence.js:55          (read; falls back to domain)
--   - routes/arion.js:6523, 6558, 6600         (read + UPDATE in arion.js settings save)
--   - routes/oauth.js:304                      (UPDATE on legacy OAuth callback)
--   - routes/onboarding/google-oauth.js:309    (UPDATE in IA-managed mirror)
--   - scripts/_force_autoselect.js:94          (UPDATE on backfill)
--
-- Until now the column was only present ad-hoc in some environments. This
-- migration formalizes it so the IF COL_LENGTH() runtime guards in the
-- handlers can be retired and migrations are the single source of truth.

IF COL_LENGTH('arion.site', 'gsc_site_url') IS NULL
BEGIN
  ALTER TABLE arion.site
    ADD gsc_site_url NVARCHAR(500) NULL;
END
GO
