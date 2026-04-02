-- Arion Schema V2 Migration
-- Creates 6 tables in the arion schema, all IF NOT EXISTS guarded

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'arion')
    EXEC('CREATE SCHEMA arion');

-- 1. arion.site
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'site')
BEGIN
    CREATE TABLE arion.site (
        site_id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
        tenant_id            UNIQUEIDENTIFIER NOT NULL,
        domain               NVARCHAR(253)    NULL,
        hosting_plan         NVARCHAR(50)     NULL DEFAULT 'starter',
        wp_admin_url         NVARCHAR(500)    NULL,
        status               NVARCHAR(30)     NOT NULL DEFAULT 'provisioning',
        ssl_expiry           DATETIMEOFFSET   NULL,
        arion_tier           NVARCHAR(20)     NOT NULL DEFAULT 'lite',
        gbp_connected        BIT              NOT NULL DEFAULT 0,
        gbp_place_id         NVARCHAR(100)    NULL,
        gbp_oauth_token_ref  NVARCHAR(200)    NULL,
        gsc_connected        BIT              NOT NULL DEFAULT 0,
        gsc_oauth_token_ref  NVARCHAR(200)    NULL,
        apple_claimed        BIT              NOT NULL DEFAULT 0,
        google_ads_linked    BIT              NOT NULL DEFAULT 0,
        site_token_hash      NVARCHAR(64)     NULL,
        site_token_last_rotated DATETIMEOFFSET NULL,
        plugin_version       NVARCHAR(20)     NULL,
        created_at           DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
        updated_at           DATETIMEOFFSET   NOT NULL DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_site_tenant_not_empty CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
    );
    CREATE INDEX IX_site_tenant_id ON arion.site (tenant_id);
END;

-- 2. arion.site_form_submission
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'site_form_submission')
BEGIN
    CREATE TABLE arion.site_form_submission (
        submission_id   UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        tenant_id       UNIQUEIDENTIFIER NOT NULL,
        site_id         UNIQUEIDENTIFIER NOT NULL,
        form_id         NVARCHAR(100)    NULL,
        form_config_id  UNIQUEIDENTIFIER NULL,
        form_type       NVARCHAR(30)     NOT NULL DEFAULT 'contact',
        submission_key  NVARCHAR(200)    NULL,
        first_name      NVARCHAR(100)    NULL,
        last_name       NVARCHAR(100)    NULL,
        email           NVARCHAR(254)    NULL,
        phone           NVARCHAR(30)     NULL,
        message         NVARCHAR(MAX)    NULL,
        raw_fields      NVARCHAR(MAX)    NULL,
        utm_source      NVARCHAR(100)    NULL,
        utm_medium      NVARCHAR(100)    NULL,
        utm_campaign    NVARCHAR(100)    NULL,
        contact_id      UNIQUEIDENTIFIER NULL,
        lead_id         UNIQUEIDENTIFIER NULL,
        processed       BIT              DEFAULT 0,
        submitted_at    DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        created_at      DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_site_form_submission_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
    );
    CREATE UNIQUE INDEX UX_submission_tenant_key ON arion.site_form_submission (tenant_id, submission_key) WHERE submission_key IS NOT NULL;
    CREATE INDEX IX_submission_tenant_site_date ON arion.site_form_submission (tenant_id, site_id, submitted_at DESC);
END;

-- 3. arion.site_form_config
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'site_form_config')
BEGIN
    CREATE TABLE arion.site_form_config (
        config_id   UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        tenant_id   UNIQUEIDENTIFIER NOT NULL,
        site_id     UNIQUEIDENTIFIER NOT NULL,
        form_id     NVARCHAR(100)    NOT NULL,
        form_name   NVARCHAR(200)    NULL,
        form_type   NVARCHAR(30)     DEFAULT 'contact',
        field_map   NVARCHAR(MAX)    NULL,
        is_active   BIT              DEFAULT 1,
        created_at  DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        updated_at  DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_site_form_config_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
        CONSTRAINT UQ_form_config_tenant_site_form UNIQUE (tenant_id, site_id, form_id)
    );
END;

-- 4. arion.site_booking_request
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'site_booking_request')
BEGIN
    CREATE TABLE arion.site_booking_request (
        booking_request_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        tenant_id          UNIQUEIDENTIFIER NOT NULL,
        site_id            UNIQUEIDENTIFIER NOT NULL,
        form_id            NVARCHAR(100)    NULL,
        form_config_id     UNIQUEIDENTIFIER NULL,
        first_name         NVARCHAR(100)    NULL,
        last_name          NVARCHAR(100)    NULL,
        email              NVARCHAR(254)    NULL,
        phone              NVARCHAR(30)     NULL,
        service_type       NVARCHAR(200)    NULL,
        preferred_date     DATE             NULL,
        preferred_time     NVARCHAR(50)     NULL,
        address_line_1     NVARCHAR(200)    NULL,
        city               NVARCHAR(100)    NULL,
        state              NVARCHAR(50)     NULL,
        postal_code        NVARCHAR(20)     NULL,
        message            NVARCHAR(MAX)    NULL,
        raw_fields         NVARCHAR(MAX)    NULL,
        utm_source         NVARCHAR(100)    NULL,
        utm_medium         NVARCHAR(100)    NULL,
        utm_campaign       NVARCHAR(100)    NULL,
        status             NVARCHAR(30)     DEFAULT 'new',
        oliver_inquiry_id  UNIQUEIDENTIFIER NULL,
        contact_id         UNIQUEIDENTIFIER NULL,
        lead_id            UNIQUEIDENTIFIER NULL,
        processed          BIT              DEFAULT 0,
        submission_key     NVARCHAR(200)    NULL,
        submitted_at       DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        created_at         DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_site_booking_request_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000')
    );
    CREATE INDEX IX_booking_tenant_key ON arion.site_booking_request (tenant_id, submission_key) WHERE submission_key IS NOT NULL;
    CREATE INDEX IX_booking_tenant_site_date ON arion.site_booking_request (tenant_id, site_id, submitted_at DESC);
    CREATE INDEX IX_booking_tenant_status_date ON arion.site_booking_request (tenant_id, status, preferred_date);
END;

-- 5. arion.gbp_review
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'gbp_review')
BEGIN
    CREATE TABLE arion.gbp_review (
        review_id       UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        tenant_id       UNIQUEIDENTIFIER NOT NULL,
        site_id         UNIQUEIDENTIFIER NOT NULL,
        gbp_review_id   NVARCHAR(200)    NOT NULL,
        reviewer_name   NVARCHAR(200)    NULL,
        star_rating     INT              NOT NULL,
        review_text     NVARCHAR(MAX)    NULL,
        reply_text      NVARCHAR(MAX)    NULL,
        reply_status    NVARCHAR(20)     DEFAULT 'none',
        review_date     DATETIMEOFFSET   NULL,
        synced_at       DATETIMEOFFSET   NULL,
        created_at      DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_gbp_review_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
        CONSTRAINT CK_gbp_review_star_rating CHECK (star_rating >= 1 AND star_rating <= 5),
        CONSTRAINT UQ_gbp_review_tenant_reviewid UNIQUE (tenant_id, gbp_review_id)
    );
END;

-- 6. arion.gbp_insights
IF NOT EXISTS (SELECT * FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE s.name = 'arion' AND t.name = 'gbp_insights')
BEGIN
    CREATE TABLE arion.gbp_insights (
        insight_id          UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        tenant_id           UNIQUEIDENTIFIER NOT NULL,
        site_id             UNIQUEIDENTIFIER NOT NULL,
        snapshot_date       DATE             NOT NULL,
        search_impressions  INT              NULL,
        map_views           INT              NULL,
        direction_requests  INT              NULL,
        call_clicks         INT              NULL,
        website_clicks      INT              NULL,
        created_at          DATETIMEOFFSET   DEFAULT SYSDATETIMEOFFSET(),
        CONSTRAINT CK_gbp_insights_tenant CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
        CONSTRAINT UQ_gbp_insights_tenant_site_date UNIQUE (tenant_id, site_id, snapshot_date)
    );
END;
