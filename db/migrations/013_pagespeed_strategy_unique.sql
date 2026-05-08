-- Migration 013: Allow mobile + desktop snapshots on the same day
-- Migration 005 created UQ_pagespeed_site_date as UNIQUE(tenant_id, site_id, run_date)
-- but migration 012 added a strategy column meant to support both mobile + desktop
-- in the same day. The old constraint blocks the second strategy from inserting.

IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_pagespeed_site_date' AND type = 'UQ')
  ALTER TABLE arion.site_pagespeed_snapshot DROP CONSTRAINT UQ_pagespeed_site_date;

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_pagespeed_site_date_strategy' AND type = 'UQ')
  ALTER TABLE arion.site_pagespeed_snapshot
  ADD CONSTRAINT UQ_pagespeed_site_date_strategy UNIQUE (tenant_id, site_id, run_date, strategy);
