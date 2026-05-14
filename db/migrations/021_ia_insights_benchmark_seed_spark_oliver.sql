-- 021_ia_insights_benchmark_seed_spark_oliver.sql — Extend benchmarks
-- with SPARK + OLIVER metrics (v5.23)
--
-- Adds rows for SPARK trend-engine metrics (growth_rate, win_rate,
-- open_rate, click_rate, etc.) and OLIVER metrics (on_time_rate,
-- paid_rate, win_rate, repeat_rate, etc.) across the same service
-- categories the ARION engines use.

-- ── home_services category ───────────────────────────────────────────
-- SPARK metrics
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='contact_growth_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'contact_growth_rate_pct', 5.0, 'percent', 'New contacts as % of base per 90d');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='lead_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'lead_win_rate_pct', 30.0, 'percent', 'Lead → won/closed rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='email_open_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'email_open_rate_pct', 22.0, 'percent', 'Service-business email open rate baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='email_click_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'email_click_rate_pct', 3.5, 'percent', 'Service-business email click rate baseline');
-- OLIVER metrics
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='on_time_completion_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'on_time_completion_pct', 80.0, 'percent', 'Job on-time completion rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='paid_invoice_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'paid_invoice_rate_pct', 75.0, 'percent', 'Invoice paid within 30 days baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='quote_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'quote_win_rate_pct', 45.0, 'percent', 'Quote → accepted rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='home_services' AND metric_key='repeat_jobs_per_customer')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('home_services', 'repeat_jobs_per_customer', 2.0, 'jobs', 'Average repeat jobs per customer per year');

-- ── legal category ──────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='lead_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'lead_win_rate_pct', 35.0, 'percent', 'Higher quote-to-engagement rate due to consultation funnel');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='email_open_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'email_open_rate_pct', 25.0, 'percent', 'Legal-services email open rate');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='legal' AND metric_key='paid_invoice_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('legal', 'paid_invoice_rate_pct', 85.0, 'percent', 'Retainer-driven payment reliability');

-- ── health category ──────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='health' AND metric_key='lead_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('health', 'lead_win_rate_pct', 40.0, 'percent', 'Healthcare lead-to-booking baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='health' AND metric_key='repeat_jobs_per_customer')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('health', 'repeat_jobs_per_customer', 4.0, 'visits', 'Healthcare visit frequency per year baseline');

-- ── b2b category ────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='b2b' AND metric_key='lead_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('b2b', 'lead_win_rate_pct', 25.0, 'percent', 'B2B lead-to-close baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='b2b' AND metric_key='email_open_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('b2b', 'email_open_rate_pct', 20.0, 'percent', 'B2B email open rate baseline');

-- ── default fallback ────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='lead_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'lead_win_rate_pct', 30.0, 'percent', 'Generic baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='email_open_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'email_open_rate_pct', 20.0, 'percent', 'Generic baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='on_time_completion_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'on_time_completion_pct', 75.0, 'percent', 'Generic on-time baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='paid_invoice_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'paid_invoice_rate_pct', 70.0, 'percent', 'Generic invoice payment baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='quote_win_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'quote_win_rate_pct', 40.0, 'percent', 'Generic quote acceptance baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='contact_growth_rate_pct')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'contact_growth_rate_pct', 5.0, 'percent', 'Generic contact growth baseline');
IF NOT EXISTS (SELECT 1 FROM arion.ia_insights_benchmark WHERE service_category='default' AND metric_key='repeat_jobs_per_customer')
  INSERT INTO arion.ia_insights_benchmark (service_category, metric_key, benchmark_value, units, notes) VALUES ('default', 'repeat_jobs_per_customer', 1.5, 'jobs', 'Generic repeat-job baseline');
GO
