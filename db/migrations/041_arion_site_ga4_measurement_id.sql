-- 041 — arion.site.ga4_measurement_id
-- Purpose: add ga4_measurement_id column so the arion-api can persist the
-- GA4 web data-stream Measurement ID (format 'G-XXXXXXXXXX') captured during
-- IA-master auto-provision. The IA WordPress plugin reads this value and
-- auto-injects the gtag snippet on the customer's site (F-Onb-D1).
-- Note: the plugin push respects a WordPress filter hook
-- (`ia_ga4_gtag_enabled`) on the PHP side so customers can opt out.
-- Date: 2026-07-01

IF OBJECT_ID('arion.site') IS NOT NULL AND COL_LENGTH('arion.site', 'ga4_measurement_id') IS NULL
BEGIN
  ALTER TABLE arion.site ADD ga4_measurement_id NVARCHAR(100) NULL;
END
GO

-- Optional index for lookups when the plugin push runs
IF EXISTS (SELECT 1 FROM sys.tables WHERE object_id = OBJECT_ID('arion.site'))
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_site_ga4_measurement_id' AND object_id = OBJECT_ID('arion.site'))
BEGIN
  CREATE NONCLUSTERED INDEX IX_site_ga4_measurement_id ON arion.site(ga4_measurement_id) WHERE ga4_measurement_id IS NOT NULL;
END
GO

-- Rollback:
-- IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_site_ga4_measurement_id' AND object_id = OBJECT_ID('arion.site'))
--     DROP INDEX IX_site_ga4_measurement_id ON arion.site;
-- GO
-- IF COL_LENGTH('arion.site', 'ga4_measurement_id') IS NOT NULL
--     ALTER TABLE arion.site DROP COLUMN ga4_measurement_id;
-- GO
