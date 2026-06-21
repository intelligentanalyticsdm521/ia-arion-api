-- Migration 027: arion.business_location — multi-location GBP store
--
-- Why:
--   Onboarding V3 Phase 3 ships multi-location auto-import for tenants with
--   more than one Google Business Profile listing (e.g. a regional plumbing
--   company with 4 branches). Today arion.site holds a single
--   gbp_location_name; that single-row design can't represent a multi-branch
--   tenant. This table is the canonical row-per-location store keyed by
--   (tenant_id, gbp_location_id) so every branch has its own address, phone,
--   place id, and verified flag.
--
--   The existing single-site flow keeps working: arion.site.gbp_location_name
--   still holds the SELECTED location for a given site. The new table is the
--   set of ALL discoverable locations; the per-site selection picks one out of
--   it. Tenants with a single GBP listing get one row here + auto-selected
--   on arion.site, exactly as today.
--
--   Stored on every OAuth completion + on-demand sync via gbpSync.syncAllLocations.
--
-- Schema notes:
--   - PK is location_id (UNIQUEIDENTIFIER, NEWSEQUENTIALID default — better
--     than NEWID for clustered-PK insert performance on Azure SQL).
--   - UNIQUE (tenant_id, gbp_location_id) enforces idempotent upsert keyed by
--     Google's stable location id (the "{locationId}" half of the
--     "accounts/{a}/locations/{l}" resource name). Storing both halves lets
--     the sync layer rebuild the full resource name without ambiguity.
--   - is_primary defaults to 0; gbpSync flips one row per tenant to 1 on
--     first sync if nothing is primary yet. The Portal can move primary later
--     via POST /arion/business-locations/:id/set-primary.
--   - is_verified mirrors Google's metadata.hasPendingEdits / hasGoogleUpdated
--     state — we treat "verified" as "Google considers the listing verified",
--     which the API returns as locationState.isVerified on the v4 endpoint or
--     metadata.canHaveBusinessCalls on v1. The sync layer derives this.
--   - Indexes: by tenant for the list endpoint, by site for the foreign-key
--     joins from arion.site.
--
-- Idempotent. Safe to re-run.
--
-- References:
--   lib/integrations/gbpSync.js          (this migration's primary writer)
--   lib/gbpApi.js (listAllGbpLocations)  (read source)
--   routes/arion.js (/business-locations endpoints)
--   db/migrations/003_arion_live_data_tables.sql (arion.gbp_profile, the single-site profile)
--   db/migrations/007_arion_gbp_location_name.sql (arion.site.gbp_location_name)

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'business_location' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.business_location (
    location_id        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_business_location_id DEFAULT NEWSEQUENTIALID(),
    tenant_id          UNIQUEIDENTIFIER NOT NULL,
    site_id            UNIQUEIDENTIFIER NULL,           -- optional FK to arion.site; null when no site has claimed this location yet
    gbp_account_id     NVARCHAR(100)    NULL,           -- the "{accountId}" half of accounts/{a}/locations/{l}
    gbp_location_id    NVARCHAR(100)    NOT NULL,       -- the "{locationId}" half — globally unique within Google
    location_name      NVARCHAR(200)    NULL,           -- full "accounts/{a}/locations/{l}" string for convenience
    display_name       NVARCHAR(200)    NULL,           -- the storefront name shown on the listing
    address_line1      NVARCHAR(500)    NULL,
    city               NVARCHAR(100)    NULL,
    region             NVARCHAR(100)    NULL,           -- state / province / administrativeArea
    postal_code        NVARCHAR(20)     NULL,
    country            NVARCHAR(2)      NULL,           -- ISO 3166-1 alpha-2
    latitude           DECIMAL(10, 7)   NULL,
    longitude          DECIMAL(10, 7)   NULL,
    phone              NVARCHAR(50)     NULL,
    website            NVARCHAR(500)    NULL,
    primary_category   NVARCHAR(200)    NULL,
    place_id           NVARCHAR(100)    NULL,           -- Google Places id — drives review automation
    review_uri         NVARCHAR(500)    NULL,           -- newReviewUri or computed from place_id
    is_primary         BIT              NOT NULL CONSTRAINT DF_business_location_is_primary DEFAULT 0,
    is_verified        BIT              NOT NULL CONSTRAINT DF_business_location_is_verified DEFAULT 0,
    last_synced_at     DATETIMEOFFSET   NULL,
    created_at         DATETIMEOFFSET   NOT NULL CONSTRAINT DF_business_location_created_at DEFAULT SYSDATETIMEOFFSET(),
    updated_at         DATETIMEOFFSET   NOT NULL CONSTRAINT DF_business_location_updated_at DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_business_location PRIMARY KEY (location_id),
    CONSTRAINT CK_business_location_tenant_nonempty
      CHECK (tenant_id <> '00000000-0000-0000-0000-000000000000'),
    CONSTRAINT UQ_business_location_tenant_gbp UNIQUE (tenant_id, gbp_location_id)
  );

  CREATE INDEX IX_business_location_tenant ON arion.business_location(tenant_id);
  CREATE INDEX IX_business_location_site ON arion.business_location(site_id) WHERE site_id IS NOT NULL;
  CREATE INDEX IX_business_location_primary ON arion.business_location(tenant_id, is_primary) WHERE is_primary = 1;
END;

PRINT 'Migration 027 applied: arion.business_location created.';
