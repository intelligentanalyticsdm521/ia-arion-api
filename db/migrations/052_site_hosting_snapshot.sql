-- 052_site_hosting_snapshot.sql
--
-- Hosting, domain and DNS state, captured daily.
--
-- Brandon 2026-08-14: "Hosting we don't have a single report, is that on
-- purpose? We should have data from hostinger that we can pull here, right?"
-- Not on purpose — the Hostinger integration exposes domain registration, DNS
-- records and SSL status, and every one of those calls was live-only. Nothing
-- was stored, so nothing could be trended and no report could exist.
--
-- What lives here is the checklist a consultant runs on day one and nobody
-- runs again until something breaks:
--
--   * SSL expiry            — a lapsed certificate takes the site off the
--                             internet and the first warning most owners get
--                             is a customer phoning.
--   * Domain expiry         — worse: losing the domain loses the business.
--   * SPF / DKIM / DMARC    — missing records are why "our email goes to spam",
--                             and the answer is three DNS entries.
--   * Nameservers, A record — where the site actually points, which is the
--                             first thing to check when a migration goes wrong.
--
-- Daily grain so "the certificate renewed" and "someone changed the A record"
-- are both visible as events rather than inferred from a support ticket.

IF OBJECT_ID('arion.site_hosting_snapshot', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_hosting_snapshot (
    hosting_snapshot_id BIGINT IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_site_hosting_snapshot PRIMARY KEY,
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,
    snapshot_date    DATE             NOT NULL,

    -- certificate
    ssl_valid        BIT              NULL,
    ssl_issuer       NVARCHAR(200)    NULL,
    ssl_expires_at   DATETIME2        NULL,
    ssl_days_left    INT              NULL,

    -- registration
    domain_expires_at DATETIME2       NULL,
    domain_days_left  INT             NULL,
    domain_auto_renew BIT             NULL,
    registrar         NVARCHAR(200)   NULL,

    -- where it points
    nameservers      NVARCHAR(500)    NULL,
    a_record         NVARCHAR(100)    NULL,

    -- email deliverability: the three records that decide whether mail lands
    has_spf          BIT              NULL,
    has_dkim         BIT              NULL,
    has_dmarc        BIT              NULL,
    mx_count         INT              NULL,

    -- environment
    php_version      NVARCHAR(20)     NULL,
    wp_version       NVARCHAR(20)     NULL,
    dns_record_count INT              NULL,

    captured_at      DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_site_hosting_snapshot_cap DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE UNIQUE INDEX UX_site_hosting_snapshot_day
    ON arion.site_hosting_snapshot (site_id, snapshot_date);
END
GO
