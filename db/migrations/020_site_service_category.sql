-- 020_site_service_category.sql — Per-site service category (v5.22)
--
-- Drives industry benchmark selection in the ARION trend engines. Values
-- map to keys in arion.ia_insights_benchmark.service_category. Defaults
-- to 'home_services' when null (matches the seed data).

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name='service_category' AND Object_ID=Object_ID('arion.site'))
BEGIN
  ALTER TABLE arion.site ADD service_category NVARCHAR(60) NULL;
END
GO
