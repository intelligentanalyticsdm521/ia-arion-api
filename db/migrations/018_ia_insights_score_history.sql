-- 018_ia_insights_score_history.sql — Per-site report score history (v5.0).
--
-- The IA Insights header (4-gauge + 2 bar-chart) needs prior-period scores
-- for ghost-bar comparison. Trend engines run client-side; this table just
-- stores the resulting scores per period so we can look up "what did
-- Visibility & Reach score 90 days ago".

IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name='arion' AND t.name='ia_insights_score_history')
BEGIN
  CREATE TABLE arion.ia_insights_score_history (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    tenant_id     UNIQUEIDENTIFIER NOT NULL,
    site_id       UNIQUEIDENTIFIER NOT NULL,
    /* report key matches the engine key on the frontend:
       visibility | audience | conversion | search | content | local | technical | presence */
    report_key    NVARCHAR(40) NOT NULL,
    period_end    DATE NOT NULL,
    period_start  DATE NOT NULL,
    score         INT NOT NULL,
    /* freeform JSON of score inputs (key/value/weight) — useful for
       analytical trend tracking later. */
    score_inputs_json NVARCHAR(MAX) NULL,
    created_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );

  CREATE UNIQUE INDEX UX_arion_ia_score_history_unique
    ON arion.ia_insights_score_history(tenant_id, site_id, report_key, period_end);
  CREATE INDEX IX_arion_ia_score_history_lookup
    ON arion.ia_insights_score_history(tenant_id, site_id, report_key, period_end DESC);
END
GO

-- Industry benchmarks per service category. Initially empty; the engines
-- fall back to a generic default. Operations team populates over time.
IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name='arion' AND t.name='ia_insights_benchmark')
BEGIN
  CREATE TABLE arion.ia_insights_benchmark (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    service_category NVARCHAR(60) NOT NULL,   -- 'home_services'|'health'|'legal'|'b2b' etc
    metric_key    NVARCHAR(60) NOT NULL,      -- 'impression_to_visit'|'mobile_share'|'avg_session_duration'|'review_velocity'|'cwv_mobile_lcp_ms'
    benchmark_value FLOAT NOT NULL,
    units         NVARCHAR(20) NULL,           -- 'percent'|'seconds'|'ms'
    notes         NVARCHAR(MAX) NULL,
    updated_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_arion_ia_benchmark_unique
    ON arion.ia_insights_benchmark(service_category, metric_key);
END
GO

-- Tenant service-area config (for geographic relevance check in Visibility &
-- Reach). Stored at site level since a tenant can have multiple ARION sites
-- with different service areas.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name='service_area_json' AND Object_ID=Object_ID('arion.site'))
BEGIN
  ALTER TABLE arion.site ADD service_area_json NVARCHAR(MAX) NULL;
END
GO
