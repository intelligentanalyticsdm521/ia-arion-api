-- 039 — arion.sso_launch_token
-- Short-lived single-use tokens that authorize a Portal user to land
-- in wp-admin already signed in as the matching WP user. Minted by
-- POST /arion/sites/:siteId/sso/mint (Portal-authenticated), redeemed
-- by the IA plugin via POST /arion/sso/verify (X-Arion-Site-Token).
-- TTL 60s; one-time use (redeemed_at IS NOT NULL after redemption).

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='sso_launch_token')
BEGIN
  CREATE TABLE arion.sso_launch_token (
    token_id           UNIQUEIDENTIFIER     NOT NULL DEFAULT NEWSEQUENTIALID(),
    token_hash         NVARCHAR(128)        NOT NULL,
    site_id            UNIQUEIDENTIFIER     NOT NULL,
    tenant_id          UNIQUEIDENTIFIER     NOT NULL,
    portal_user_email  NVARCHAR(320)        NOT NULL,
    created_at         DATETIMEOFFSET       NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at         DATETIMEOFFSET       NOT NULL,
    redeemed_at        DATETIMEOFFSET       NULL,
    redeemed_user_ip   NVARCHAR(64)         NULL,
    CONSTRAINT PK_arion_sso_launch_token PRIMARY KEY (token_id)
  );
  CREATE UNIQUE INDEX UX_sso_token_hash ON arion.sso_launch_token(token_hash);
  CREATE INDEX IX_sso_token_site ON arion.sso_launch_token(site_id, expires_at);
END
GO
