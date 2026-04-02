import sql from 'mssql';

export async function provisionSite(pool, siteId, tenantId) {
  // Phase 1 (P0): Semi-manual provisioning
  // The site record is already created with status='provisioning'
  // An admin will manually:
  // 1. Clone Golden Master on Hostinger
  // 2. Configure domain/DNS
  // 3. Install IA plugin
  // 4. Call POST /internal/sites/:siteId/complete-provisioning

  console.log(`[provisioner] Site ${siteId} queued for manual provisioning`);

  // Update status to indicate it's waiting for manual setup
  await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      UPDATE arion.site 
      SET status = 'awaiting_setup', updated_at = SYSDATETIMEOFFSET()
      WHERE site_id = @siteId AND tenant_id = @tenantId
    `);

  return { status: 'awaiting_setup' };
}

export async function completeProvisioning(pool, siteId, tenantId, { wp_admin_url, domain, ssl_expiry }) {
  const result = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('wpAdminUrl', sql.NVarChar(500), wp_admin_url)
    .input('domain', sql.NVarChar(253), domain || null)
    .input('sslExpiry', sql.DateTimeOffset, ssl_expiry || null)
    .query(`
      UPDATE arion.site 
      SET status = 'active',
          wp_admin_url = @wpAdminUrl,
          domain = COALESCE(@domain, domain),
          ssl_expiry = @sslExpiry,
          updated_at = SYSDATETIMEOFFSET()
      WHERE site_id = @siteId AND tenant_id = @tenantId AND status IN ('provisioning', 'awaiting_setup')
    `);

  if (result.rowsAffected[0] === 0) {
    throw new Error('Site not found or not in provisioning state');
  }

  return { status: 'active' };
}
