-- 050_site_link_and_media.sql
--
-- Storage for the two v1.4.0 plugin endpoints: /content/links and /media/audit.
--
-- Brandon: "this software acts as the first line of consulting. If I were to
-- come in and analyze someone's site these are things I'd review."
--
-- These are the two questions a consultant asks that WordPress itself cannot
-- answer:
--
--   Can anyone actually REACH this page?  An orphan — no inbound link, not in a
--   menu — exists only for whoever already has the URL. Google treats it as an
--   afterthought and so do visitors. On intelligentanalyticsdm.com the first
--   real run found 30 orphans out of 115 pages, and 11 links pointing at pages
--   that no longer exist.
--
--   What is the media library doing to the site?  A phone photo dropped
--   straight into a page is 4MB and 4000px wide and nothing in WordPress ever
--   mentions it. Same first run: 162 files, 34MB, 150 missing alt text, 119
--   referenced by nothing at all.
--
-- Daily grain, same as arion.site_content_item (048), so a page's inbound-link
-- count and the library's weight are both trendable rather than a point read.
-- Tier gates what we SHOW, not what we keep.

-- ── per-page link graph ────────────────────────────────────────────────────
IF OBJECT_ID('arion.site_page_link', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_page_link (
    page_link_id     BIGINT IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_site_page_link PRIMARY KEY,
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,
    snapshot_date    DATE             NOT NULL,

    post_id          INT              NOT NULL,
    title            NVARCHAR(400)    NULL,
    url_path         NVARCHAR(500)    NULL,   -- normalised, joins to site_content_item

    links_out        INT              NULL,   -- internal links leaving this page
    links_out_external INT            NULL,
    links_in         INT              NULL,   -- distinct published pages linking here
    in_menu          BIT              NULL,
    is_orphan        BIT              NULL,   -- no inbound link, no menu entry, not the front page
    -- Two different problems needing two different fixes, so they are counted
    -- apart: a link to a page that is gone (404 — fix or redirect) versus a
    -- link to one that exists but was never published (publish, or stop
    -- linking). WordPress surfaces neither.
    to_missing       INT              NULL,
    to_unpublished   INT              NULL,
    to_missing_paths NVARCHAR(MAX)    NULL,   -- json array, so the fix list is concrete

    captured_at      DATETIMEOFFSET   NOT NULL CONSTRAINT DF_site_page_link_cap DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE UNIQUE INDEX UX_site_page_link_day
    ON arion.site_page_link (site_id, post_id, snapshot_date);
  CREATE INDEX IX_site_page_link_site_day
    ON arion.site_page_link (site_id, snapshot_date) INCLUDE (links_in, is_orphan);
END
GO

-- ── media library ──────────────────────────────────────────────────────────
IF OBJECT_ID('arion.site_media_item', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_media_item (
    media_item_id    BIGINT IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_site_media_item PRIMARY KEY,
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,
    snapshot_date    DATE             NOT NULL,

    attachment_id    INT              NOT NULL,
    title            NVARCHAR(400)    NULL,
    file_path        NVARCHAR(500)    NULL,
    mime             NVARCHAR(100)    NULL,
    bytes            BIGINT           NULL,
    width            INT              NULL,
    height           INT              NULL,
    has_alt          BIT              NULL,
    is_image         BIT              NULL,
    -- "referenced" is decided against the real content of published pages, not
    -- the attached/unattached flag — unattached and unused are different things
    -- and only one of them is safe to delete.
    referenced       BIT              NULL,
    oversized        BIT              NULL,   -- >500KB or >2500px wide
    attached_to      INT              NULL,
    uploaded_at      DATETIME2        NULL,

    captured_at      DATETIMEOFFSET   NOT NULL CONSTRAINT DF_site_media_item_cap DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE UNIQUE INDEX UX_site_media_item_day
    ON arion.site_media_item (site_id, attachment_id, snapshot_date);
  CREATE INDEX IX_site_media_item_site_day
    ON arion.site_media_item (site_id, snapshot_date) INCLUDE (bytes, has_alt, referenced, oversized);
END
GO
