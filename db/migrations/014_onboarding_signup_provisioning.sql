-- Migration 014: Onboarding signup + provisioning state tables
-- Adds the data plane behind the public signup flow:
--   - arion.tenant: top-level customer account (Stripe customer + plan)
--   - arion.signup_session: Stripe-checkout-session → tenant lookup
--   - arion.stripe_webhook_log: idempotency dedupe for Stripe webhooks
--   - arion.site columns: domain_mode, branding_*, provisioning_state, etc.
--
-- This migration is idempotent — every CREATE/ALTER is guarded.

-- ---------------------------------------------------------------------------
-- arion.tenant
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tenant' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.tenant (
    tenant_id                UNIQUEIDENTIFIER  NOT NULL PRIMARY KEY,
    primary_email            NVARCHAR(320)     NOT NULL,
    plan                     NVARCHAR(40)      NOT NULL DEFAULT 'starter',  -- starter|essentials|growth|authority
    billing_cycle            NVARCHAR(20)      NOT NULL DEFAULT 'monthly',  -- monthly|annual
    status                   NVARCHAR(40)      NOT NULL DEFAULT 'pending_onboarding',
                                                                            -- pending_onboarding|active|past_due|cancelled|paused
    stripe_customer_id       NVARCHAR(200)     NULL,
    stripe_subscription_id   NVARCHAR(200)     NULL,
    created_at               DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at               DATETIMEOFFSET    NULL
  );

  CREATE INDEX IX_tenant_email   ON arion.tenant(primary_email);
  CREATE INDEX IX_tenant_stripe  ON arion.tenant(stripe_customer_id);
  CREATE INDEX IX_tenant_sub     ON arion.tenant(stripe_subscription_id);
END;

-- ---------------------------------------------------------------------------
-- arion.signup_session
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'signup_session' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.signup_session (
    session_pk               INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    stripe_session_id        NVARCHAR(200)     NOT NULL UNIQUE,
    tenant_id                UNIQUEIDENTIFIER  NOT NULL,
    site_id                  UNIQUEIDENTIFIER  NOT NULL,
    email                    NVARCHAR(320)     NOT NULL,
    questionnaire_json       NVARCHAR(MAX)     NULL,    -- the 11-field answers
    questionnaire_submitted_at DATETIMEOFFSET  NULL,
    created_at               DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE INDEX IX_signup_session_tenant ON arion.signup_session(tenant_id);
END;

-- ---------------------------------------------------------------------------
-- arion.stripe_webhook_log (idempotency dedupe)
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'stripe_webhook_log' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.stripe_webhook_log (
    log_pk         INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    event_id       NVARCHAR(200)     NOT NULL UNIQUE,
    event_type     NVARCHAR(100)     NOT NULL,
    payload        NVARCHAR(MAX)     NULL,
    received_at    DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE INDEX IX_stripe_webhook_log_type ON arion.stripe_webhook_log(event_type);
END;

-- ---------------------------------------------------------------------------
-- arion.site additions
--   domain_mode, tier (canonical), provisioning_state, branding_*,
--   feature_addons_json, provisioned_at, provisioning_details_json
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'domain_mode' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD domain_mode NVARCHAR(20) NULL;  -- purchase|byod

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'tier' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD tier NVARCHAR(40) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'provisioning_state' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD provisioning_state NVARCHAR(40) NULL;
  -- Values used by signup/provisioning pipeline:
  -- awaiting_questionnaire | awaiting_payment | dns_verifying |
  -- ai_builder_running | manifest_fetched | ready | ready_partial | failed

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'branding_primary_color' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD branding_primary_color NVARCHAR(20) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'branding_logo_url' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD branding_logo_url NVARCHAR(500) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'branding_font_family' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD branding_font_family NVARCHAR(80) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'feature_addons_json' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD feature_addons_json NVARCHAR(2000) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'provisioned_at' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD provisioned_at DATETIME2 NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'provisioning_details_json' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD provisioning_details_json NVARCHAR(MAX) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'hostinger_website_id' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD hostinger_website_id NVARCHAR(80) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'hostinger_subscription_id' AND Object_ID = Object_ID('arion.site'))
  ALTER TABLE arion.site ADD hostinger_subscription_id NVARCHAR(80) NULL;
