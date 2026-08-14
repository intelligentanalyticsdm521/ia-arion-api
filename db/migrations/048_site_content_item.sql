-- 048_site_content_item.sql
--
-- Per-PAGE content history — the storage gap under the Website reports.
--
-- Brandon 2026-08-14: "this is the level of detail that we need... this software
-- acts as the first line of consulting. If I were to come in and analyze
-- someone's site these are things I'd review."
--
-- The IA Plugin already returns everything a consultant would look at, per page:
-- `/content/seo-detail` gives up to 500 rows carrying Rank Math SEO score, focus
-- keyword, meta description length, schema type, readability, word count,
-- noindex flag and last-modified. **None of it is stored.** The nightly snapshot
-- keeps only the AGGREGATES (`rm_avg_seo_score`, `rm_posts_missing_meta`), so
-- today we can say "this page is thin and stale" but never "this page has been
-- decaying since March".
--
-- Same class of gap as the snapshot auth bug fixed in arion-func `5a4a72b`, one
-- level down: the job ran, and the detail it fetched was thrown away.
--
-- Storage has TIME VALUE — every night without capture is history that cannot be
-- recovered later. This table starts the clock; the reports that read it can be
-- written afterwards and still show a year.
--
-- Grain: one row per (site, page, snapshot_date). Daily, so a page's decay is
-- visible at the resolution the client's tier allows (Lite quarterly → Business
-- daily; the tier gates what we SHOW, not what we keep).

IF OBJECT_ID('arion.site_content_item', 'U') IS NULL
BEGIN
  CREATE TABLE arion.site_content_item (
    content_item_id  BIGINT IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_site_content_item PRIMARY KEY,
    tenant_id        UNIQUEIDENTIFIER NOT NULL,
    site_id          UNIQUEIDENTIFIER NOT NULL,
    snapshot_date    DATE             NOT NULL,

    -- WordPress identity. post_id is stable across renames; url_path is what
    -- GSC and GA4 can later be joined on (both normalise to a path).
    post_id          INT              NOT NULL,
    post_type        NVARCHAR(20)     NULL,   -- post | page
    title            NVARCHAR(400)    NULL,
    permalink        NVARCHAR(1000)   NULL,
    url_path         NVARCHAR(500)    NULL,   -- normalised: no scheme/host/www, no trailing slash

    -- The consultant's read, straight from Rank Math + the content itself.
    seo_score        INT              NULL,
    focus_keyword    NVARCHAR(255)    NULL,
    has_meta_desc    BIT              NULL,
    meta_desc_len    INT              NULL,
    schema_type      NVARCHAR(100)    NULL,
    readability      INT              NULL,
    word_count       INT              NULL,
    is_noindex       BIT              NULL,

    -- last_modified is WordPress's own, not our capture time. The gap between
    -- the two is the freshness story ("nothing has been touched in 8 months").
    last_modified    DATETIME2        NULL,
    captured_at      DATETIMEOFFSET   NOT NULL
      CONSTRAINT DF_site_content_item_captured DEFAULT SYSDATETIMEOFFSET()
  );

  -- One row per page per day. Re-running the job on the same day updates rather
  -- than duplicates, so a manual re-run is always safe.
  CREATE UNIQUE INDEX UQ_site_content_item_daily
    ON arion.site_content_item (site_id, post_id, snapshot_date);

  -- The report reads "all pages for this site on the newest date", and the trend
  -- reads "this page across dates". Both are covered here.
  CREATE INDEX IX_site_content_item_site_date
    ON arion.site_content_item (site_id, snapshot_date DESC)
    INCLUDE (post_id, seo_score, word_count, last_modified);

  -- Joining content to performance later needs the path, per site.
  CREATE INDEX IX_site_content_item_path
    ON arion.site_content_item (site_id, url_path);

  PRINT '  + arion.site_content_item (per-page daily content history)';
END
ELSE
  PRINT '  = arion.site_content_item already exists';
GO
