-- Migration 008: per-site Bing Webmaster Tools API key
-- ARION Integrations Phase 2 — April 2026
-- Prerequisite: migrations 001-007 applied

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'bing_api_key' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD bing_api_key NVARCHAR(200) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'bing_connected_at' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD bing_connected_at DATETIME2 NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'bing_site_url' AND Object_ID = OBJECT_ID(N'arion.site'))
  ALTER TABLE arion.site ADD bing_site_url NVARCHAR(300) NULL;
