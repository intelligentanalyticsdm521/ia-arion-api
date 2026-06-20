-- Migration 023: ARGUS Auto-Topoff config
-- Per-tenant auto-refill configuration for the ARGUS AI credit pack.
-- When enabled, a future scheduled job watches each tenant's balance and,
-- when it falls below `threshold_credits`, fires a Stripe Checkout (using
-- the tenant's default payment method) for `refill_pack_size` credits.
-- `max_per_month_usd` is a safety cap to prevent runaway charges.
--
-- This migration only creates the CONFIG table. The job that consumes it
-- (and the Stripe charge path) ships in a follow-up.
--
-- Prerequisite: migrations 001-022 applied, lumen schema exists.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lumen') EXEC('CREATE SCHEMA lumen');

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'lumen.argus_autotopoff_config') AND type = 'U')
CREATE TABLE lumen.argus_autotopoff_config (
  tenant_id            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
  enabled              BIT              NOT NULL DEFAULT 0,         -- off by default per scope
  threshold_credits    INT              NOT NULL DEFAULT 50,        -- refill when balance < this
  refill_pack_size     INT              NOT NULL DEFAULT 100,       -- credits per refill (catalog value)
  max_per_month_usd    INT              NOT NULL DEFAULT 300,       -- hard cap on auto-purchases
  -- Bookkeeping for the (future) auto-topoff job — running totals reset
  -- when the calendar month flips. The job updates these atomically when
  -- it fires a charge; the UI may surface them later but doesn't need to
  -- write to them.
  month_spent_usd      DECIMAL(10,2)    NOT NULL DEFAULT 0,
  month_period_start   DATE             NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
  last_charge_at       DATETIME2        NULL,
  last_charge_amount_usd DECIMAL(10,2)  NULL,
  created_at           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_by           UNIQUEIDENTIFIER NULL,
  -- Defensive guardrails — block obviously bad values at the storage layer.
  CONSTRAINT CK_argus_autotopoff_threshold_pos CHECK (threshold_credits > 0),
  CONSTRAINT CK_argus_autotopoff_pack_valid    CHECK (refill_pack_size IN (50, 100, 150, 200, 250, 300, 400, 500, 750, 1000)),
  CONSTRAINT CK_argus_autotopoff_max_pos       CHECK (max_per_month_usd >= 0)
);
