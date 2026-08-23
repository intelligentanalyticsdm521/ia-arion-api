-- 054_site_internal_ip_list.sql
-- Sept 2026 Release A (F4 — GA internal-traffic blocking, IA + client-facing).
--
-- Per-site tenant-managed exclusion entries (JSON array of IP/CIDR strings).
-- The EFFECTIVE list a site's plugin receives is IA's platform-wide list
-- (arion-api env IA_INTERNAL_IPS) merged with this column; the merge happens
-- in lib/internalTraffic.js and is pushed over the existing ga4-config
-- channel. Nullable on the arion.site god-table — no existing column touched.
--
-- Idempotent.

PRINT '[054] Adding arion.site.internal_ip_json';
GO

IF COL_LENGTH('arion.site', 'internal_ip_json') IS NULL
BEGIN
  ALTER TABLE arion.site ADD internal_ip_json NVARCHAR(MAX) NULL;
  PRINT '[054]   added arion.site.internal_ip_json';
END
ELSE
  PRINT '[054]   arion.site.internal_ip_json already exists';
GO

PRINT '[054] DONE.';
