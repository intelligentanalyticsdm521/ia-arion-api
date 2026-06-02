-- 022_plugin_distribution.sql — F-139
--
-- arion-api becomes the gatekeeper for IA plugin downloads + auto-updates.
-- Plugin .zip lives in PRIVATE blob storage (stiadmprod/plugins/...). Only
-- arion-api's managed identity can read the blob and stream it to clients
-- after validating the requester is a real IA-onboarded site.
--
-- Tables:
--
--   arion.plugin_version       — released versions per channel (latest, staging)
--   arion.plugin_download_log  — audit of every download (provisioning + updates)
--
-- Column added:
--
--   arion.site.plugin_channel  — 'latest' (default) or 'staging' (founder beta)

CREATE TABLE arion.plugin_version (
  version_id       INT IDENTITY(1,1) PRIMARY KEY,
  -- Semver-ish version string (e.g., "1.0.0", "1.0.1-beta.1"). Must be
  -- comparable lexically left-to-right OR via SemVer parsing in code.
  version          NVARCHAR(40)      NOT NULL,
  channel          NVARCHAR(20)      NOT NULL,                   -- 'latest' | 'staging'
  -- Blob path in stiadmprod/plugins container — arion-api streams via MI.
  blob_path        NVARCHAR(255)     NOT NULL,                   -- e.g., 'intelligent-analytics-latest.zip'
  changelog        NVARCHAR(MAX)     NULL,
  -- Optional checksum the plugin verifies after download (defense-in-depth).
  sha256           NVARCHAR(64)      NULL,
  released_at      DATETIME2         NOT NULL DEFAULT SYSUTCDATETIME(),
  released_by      NVARCHAR(255)     NULL,
  is_current       BIT               NOT NULL DEFAULT 0,         -- exactly one per channel
  CONSTRAINT UQ_plugin_version_channel_ver UNIQUE (channel, version)
);

-- Helper index for "what's the current version for this channel" lookup.
CREATE INDEX IX_plugin_version_current ON arion.plugin_version(channel, is_current DESC, released_at DESC);

-- Per-site channel selection. Default 'latest' for every site; founder can
-- flip individual sites to 'staging' for beta testing via:
--   UPDATE arion.site SET plugin_channel = 'staging' WHERE site_id = ...
ALTER TABLE arion.site ADD plugin_channel NVARCHAR(20) NOT NULL DEFAULT 'latest';

-- Download audit — one row per /plugin/download or /plugin/manifest-driven
-- update that actually completes.
CREATE TABLE arion.plugin_download_log (
  log_id           INT IDENTITY(1,1) PRIMARY KEY,
  site_id          UNIQUEIDENTIFIER  NULL,                       -- nullable for first-time provisioning downloads
  tenant_id        UNIQUEIDENTIFIER  NULL,
  -- 'install' = first-time install via provision code
  -- 'update'  = subsequent auto-update via site_token
  download_type    NVARCHAR(20)      NOT NULL,
  version          NVARCHAR(40)      NOT NULL,
  channel          NVARCHAR(20)      NOT NULL,
  bytes_streamed   BIGINT            NULL,
  ip_address       NVARCHAR(64)      NULL,
  user_agent       NVARCHAR(500)     NULL,
  succeeded        BIT               NOT NULL DEFAULT 1,
  error_message    NVARCHAR(500)     NULL,
  occurred_at      DATETIME2         NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_plugin_download_log_site ON arion.plugin_download_log(site_id, occurred_at DESC);
CREATE INDEX IX_plugin_download_log_recent ON arion.plugin_download_log(occurred_at DESC);

-- Seed: current installed version is 1.0.0 — first official production release
-- (matches IA_PLUGIN_VERSION constant in the plugin's main file). Operator
-- uploads the .zip manually to the matching blob_path; arion-api streams
-- from there once the storage role is granted.
INSERT INTO arion.plugin_version (version, channel, blob_path, changelog, released_by, is_current)
VALUES
  ('1.0.0', 'latest',  'intelligent-analytics-latest.zip',  'First official production release', 'system', 1),
  ('1.0.0', 'staging', 'intelligent-analytics-staging.zip', 'First official production release', 'system', 1);

PRINT 'Migration 022 applied: arion.plugin_version + arion.plugin_download_log + arion.site.plugin_channel';
