-- 019_ia_insights_benchmark_seed.sql — Initial industry benchmark seed (v5.13)
--
-- Initial benchmark values per service category. Used by the ARION trend
-- engines to score "actual vs. industry typical". Values sourced from
-- public industry reports (HubSpot, WordStream, BrightLocal, Wordfence).
-- Operations team can edit these in-place; no other migrations should
-- touch this table beyond extending the rows.

-- Idempotent: each insert is wrapped in IF NOT EXISTS.

DECLARE @category NVARCHAR(60), @metric NVARCHAR(60), @value FLOAT, @units NVARCHAR(20), @notes NVARCHAR(MAX);

-- Helper-free idempotent inserts (T-SQL has no UPSERT in DDL — use NOT EXISTS).
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='impression_to_visit')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'impression_to_visit', 1.5, 'percent', 'Typical impression-to-visit rate at avg SERP position 15-20');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='mobile_share')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'mobile_share', 60.0, 'percent', 'Mobile share of total sessions');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='avg_session_duration')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'avg_session_duration', 90.0, 'seconds', 'Average session duration');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='form_conversion_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'form_conversion_rate', 2.0, 'percent', 'Visit-to-form-submit rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='cwv_mobile_lcp_ms')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'cwv_mobile_lcp_ms', 2500.0, 'ms', 'Mobile LCP target — Google "good" threshold');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='gbp_avg_rating')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'gbp_avg_rating', 4.5, 'stars', 'GBP average rating to be competitive');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='gbp_response_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'gbp_response_rate', 75.0, 'percent', 'Owner response rate to reviews');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='review_velocity_per_month')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'review_velocity_per_month', 4.0, 'reviews', 'New reviews per month to maintain freshness signal');

-- Legal services category (different conversion expectations)
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='impression_to_visit')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'impression_to_visit', 1.8, 'percent', 'Legal services typically rank for high-intent queries');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='avg_session_duration')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'avg_session_duration', 150.0, 'seconds', 'Higher dwell time on content-heavy pages');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='form_conversion_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'form_conversion_rate', 3.5, 'percent', 'Higher conversion intent → higher form-fill rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='gbp_avg_rating')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'gbp_avg_rating', 4.7, 'stars', 'Legal review averages tend to be high');

-- Healthcare category
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='health' AND metric_key='impression_to_visit')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('health', 'impression_to_visit', 1.7, 'percent', 'Healthcare practices in mid-market');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='health' AND metric_key='mobile_share')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('health', 'mobile_share', 70.0, 'percent', 'Higher mobile share than home services');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='health' AND metric_key='gbp_response_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('health', 'gbp_response_rate', 85.0, 'percent', 'Patient-facing review responses');

-- Generic B2B fallback
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='b2b' AND metric_key='impression_to_visit')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('b2b', 'impression_to_visit', 2.5, 'percent', 'B2B benefits from longer brand-search cycle');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='b2b' AND metric_key='avg_session_duration')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('b2b', 'avg_session_duration', 180.0, 'seconds', 'B2B research-mode browsing');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='b2b' AND metric_key='form_conversion_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('b2b', 'form_conversion_rate', 2.5, 'percent', 'Lead-gen form rate for SaaS/services');

-- Default fallback (used when service_category is null or unmapped)
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='impression_to_visit')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'impression_to_visit', 1.5, 'percent', 'Generic baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='mobile_share')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'mobile_share', 60.0, 'percent', 'Generic baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='form_conversion_rate')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'form_conversion_rate', 2.0, 'percent', 'Generic baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='cwv_mobile_lcp_ms')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'cwv_mobile_lcp_ms', 2500.0, 'ms', 'Generic baseline');
GO
