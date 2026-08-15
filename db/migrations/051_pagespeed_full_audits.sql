-- 051_pagespeed_full_audits.sql
--
-- Store the WHOLE PageSpeed result, not a hand-picked slice of it.
--
-- Brandon 2026-08-14: "we can pull the full page speed insights, why aren't we
-- just literally building out the same reporting that they have."
--
-- The runner asks Google for all four Lighthouse categories and then keeps the
-- four category scores, six metrics, and a hardcoded list of sixteen
-- performance opportunity keys capped at eight rows. Everything else is
-- discarded on arrival:
--
--   * every ACCESSIBILITY audit — contrast, labels, alt text, ARIA, focus order
--   * every SEO audit — crawlability, canonical, hreflang, descriptions
--   * every BEST PRACTICES audit — HTTPS, console errors, deprecated APIs,
--     vulnerable libraries
--   * the performance DIAGNOSTICS that are not in the sixteen
--
-- That is the bulk of what PageSpeed actually reports, and it is the part a
-- consultant hands to a developer. audits_json keeps every audit that did not
-- pass, tagged with its category, so a report can mirror what Google shows and
-- the trend of each fix is visible over time.

IF COL_LENGTH('arion.site_pagespeed_snapshot', 'audits_json') IS NULL
  ALTER TABLE arion.site_pagespeed_snapshot ADD audits_json NVARCHAR(MAX) NULL;
GO

-- Passing counts per category, so "38 of 44 accessibility checks pass" is a
-- number we can show and trend without re-parsing the blob every read.
IF COL_LENGTH('arion.site_pagespeed_snapshot', 'audits_passed') IS NULL
  ALTER TABLE arion.site_pagespeed_snapshot ADD audits_passed INT NULL;
GO

IF COL_LENGTH('arion.site_pagespeed_snapshot', 'audits_total') IS NULL
  ALTER TABLE arion.site_pagespeed_snapshot ADD audits_total INT NULL;
GO

-- TTFB completes the Core Web Vitals picture; it was fetched and dropped.
IF COL_LENGTH('arion.site_pagespeed_snapshot', 'ttfb_ms') IS NULL
  ALTER TABLE arion.site_pagespeed_snapshot ADD ttfb_ms INT NULL;
GO

IF COL_LENGTH('arion.site_pagespeed_snapshot', 'si_ms') IS NULL
  ALTER TABLE arion.site_pagespeed_snapshot ADD si_ms INT NULL;
GO
