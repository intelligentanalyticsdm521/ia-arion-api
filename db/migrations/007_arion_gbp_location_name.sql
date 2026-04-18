-- Migration 007: store resolved GBP location name per site
-- ARION Integrations Phase 1 — April 2026
-- Prerequisite: migrations 001-006 applied

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'gbp_location_name' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD gbp_location_name NVARCHAR(200) NULL;
