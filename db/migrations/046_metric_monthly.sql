-- 046_metric_monthly.sql
--
-- The storage foundation for the whole Insights model (see
-- overnight-report/INSIGHTS_MODEL_SPEC.md): every ARION data point captured as
-- a monthly time series. Sections / dashboards / scores are roll-ups of this;
-- month-over-month and forecasting are impossible without it.
--
-- One row per (site, metric, dimension value, month). Most metrics have a
-- single overall value (dimension NULL); dimensioned metrics (impressions by
-- device, sessions by city) store one row per value so detail reports can
-- trend "mobile specifically dropped 25%".
--
-- FILLED BY: the monthly ARION snapshot job (a named prod-deploy requirement,
-- not yet built) — an arion-func timer that, on the 1st, pulls each connected
-- source and writes that month's values here. Until it runs, the demo provider
-- (lib/arionMetrics.js) generates the series so dashboards render in dev.

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'arion.metric_monthly') AND type = 'U')
CREATE TABLE arion.metric_monthly (
  metric_monthly_id  BIGINT IDENTITY(1,1) PRIMARY KEY,
  tenant_id          UNIQUEIDENTIFIER NOT NULL,
  site_id            UNIQUEIDENTIFIER NOT NULL,
  period_month       DATE             NOT NULL,   -- always the 1st of the month
  source             NVARCHAR(30)     NOT NULL,   -- gsc | ga4 | gbp | seranking | psi | plugin | bing | social
  metric_key         NVARCHAR(60)     NOT NULL,   -- matches lib/arionMetrics.js keys
  dimension          NVARCHAR(40)     NULL,        -- null = overall; else 'device' | 'city' | 'query' | 'page' ...
  dimension_value    NVARCHAR(200)    NULL,
  value              DECIMAL(18,4)    NOT NULL,
  captured_at        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_metric_monthly UNIQUE (site_id, period_month, metric_key, dimension, dimension_value)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_metric_monthly_lookup')
CREATE INDEX IX_metric_monthly_lookup
  ON arion.metric_monthly (site_id, metric_key, period_month DESC)
  INCLUDE (value, dimension, dimension_value);
