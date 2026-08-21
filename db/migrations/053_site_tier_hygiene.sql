-- 053_site_tier_hygiene.sql
--
-- Phase B1 tier-data hygiene (PRICING_REWORK_PHASE_B_SCOPE_2026-08-21.md
-- §B1 gap 4). arion.site carries THREE tier columns and two of them were
-- never written by the purchase/provisioning path until 2026-08-21/22:
--
--   arion_tier      — the BASE plan (lite|standard|pro|business|enterprise).
--                     Read by middleware/requireArionTier.js (per site, then
--                     arion.tenant.plan, then fail OPEN). NOT NULL DEFAULT
--                     'lite' (migration 001) — so a row nothing stamped is a
--                     POSITIVE Lite and locks Standard+ surfaces.
--   seo_addon_tier  — the SEO add-on ladder (starter|essentials|growth|
--                     authority). Read by middleware/requireSeoAddon.js +
--                     lib/seoOnboarding.js.
--   tier            — LEGACY mirror of the SEO ladder, still read by
--                     lib/integrationKickoff.js + lib/manifestBuilder.js
--                     (both default a NULL to 'starter'). NULL on all four
--                     prod sites as of 2026-08-21 while seo_addon_tier carries
--                     the value.
--
-- This migration backfills, it never changes shape:
--   (a) tier        := seo_addon_tier where tier is NULL and seo_addon_tier is
--                      a ladder word (so the legacy readers see the SEO rung
--                      the customer actually bought, not 'starter').
--   (b) arion_tier  := LOWER(arion.tenant.plan) where the tenant's plan is a
--                      base-ladder word HIGHER than the site's current value.
--                      Raise-only (same rule as lib/purchaseTierSync.js):
--                      NULL / unknown / the 'lite' column default are raised,
--                      a real higher rung is never lowered. Written as a rank
--                      comparison rather than `arion_tier IS NULL` because the
--                      column cannot be NULL.
--
-- Neither column is dropped — `tier` stays until its two readers move to
-- seo_addon_tier (separate change). Idempotent: re-runs match zero rows.
--
-- TARGET DB: iadm_services.

-- (a) legacy SEO-ladder mirror ← seo_addon_tier
UPDATE arion.site
   SET tier = seo_addon_tier,
       updated_at = SYSDATETIMEOFFSET()
 WHERE tier IS NULL
   AND LOWER(seo_addon_tier) IN ('starter', 'essentials', 'growth', 'authority');
GO

-- (b) base tier ← arion.tenant.plan, raise-only
UPDATE s
   SET arion_tier = LOWER(t.[plan]),
       updated_at = SYSDATETIMEOFFSET()
  FROM arion.site s
  JOIN arion.tenant t ON t.tenant_id = s.tenant_id
 CROSS APPLY (SELECT
   site_rank = CASE LOWER(ISNULL(s.arion_tier, ''))
                 WHEN 'lite' THEN 1 WHEN 'standard' THEN 2 WHEN 'pro' THEN 3
                 WHEN 'business' THEN 4 WHEN 'enterprise' THEN 5 ELSE 0 END,
   plan_rank = CASE LOWER(ISNULL(t.[plan], ''))
                 WHEN 'lite' THEN 1 WHEN 'standard' THEN 2 WHEN 'pro' THEN 3
                 WHEN 'business' THEN 4 WHEN 'enterprise' THEN 5 ELSE 0 END) r
 WHERE LOWER(t.[plan]) IN ('lite', 'standard', 'pro', 'business', 'enterprise')
   AND r.plan_rank > r.site_rank;
GO
