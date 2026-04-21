-- Migration 012: PageSpeed v2 — CrUX field data + Lighthouse Opportunities + strategy split
-- Enhances site_pagespeed_snapshot to capture the full analytics payload so we
-- can drive the visual-first Core Web Vitals rebuild without re-running PSI.

-- Add strategy column so we can store mobile + desktop as separate rows (one
-- UNIQUE key per run_date+strategy). The existing unique constraint needs to
-- drop first and be re-created if it doesn't already include strategy.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='strategy')
  ALTER TABLE arion.site_pagespeed_snapshot ADD strategy NVARCHAR(10) NULL;

-- CrUX field data (url-level + origin-level) as JSON blobs
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='crux_url_json')
  ALTER TABLE arion.site_pagespeed_snapshot ADD crux_url_json NVARCHAR(MAX) NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='crux_origin_json')
  ALTER TABLE arion.site_pagespeed_snapshot ADD crux_origin_json NVARCHAR(MAX) NULL;

-- Scores per-strategy (accessibility, SEO, best practices)
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='performance_score')
  ALTER TABLE arion.site_pagespeed_snapshot ADD performance_score INT NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='accessibility_score')
  ALTER TABLE arion.site_pagespeed_snapshot ADD accessibility_score INT NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='seo_score')
  ALTER TABLE arion.site_pagespeed_snapshot ADD seo_score INT NULL;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='best_practices_score')
  ALTER TABLE arion.site_pagespeed_snapshot ADD best_practices_score INT NULL;

-- Add a "monthly auto" flag so we can distinguish scheduled runs from manual
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site_pagespeed_snapshot' AND COLUMN_NAME='triggered_by')
  ALTER TABLE arion.site_pagespeed_snapshot ADD triggered_by NVARCHAR(50) NULL;  -- 'manual' | 'monthly' | 'onboarding'
