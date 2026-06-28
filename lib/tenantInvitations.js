/**
 * lib/tenantInvitations — upsert a pending invitation row.
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------
 * platform-api's session/verify.js auto-claims any pending
 * `core.tenant_invitations` row whose email matches the just-verified CIAM
 * user. Without an invitation row, a Path A self-serve customer who completes
 * Stripe checkout and then signs in via CIAM lands with no tenant linkage —
 * they hit AppGate's "no tenant" screen instead of their paid product.
 *
 * Path B (founder wizard) inserts the invitation in
 * oliver-api/routes/admin/onboardClient.js at finish-onboarding time. Path A
 * had no equivalent until 2026-06-27 (this file). Both paths now use the
 * same upsert shape so platform-api's claim loop sees them identically.
 *
 * Schema
 * ------
 *   core.tenant_invitations (tenant_id UNIQUEIDENTIFIER, email NVARCHAR(320),
 *                            role_key NVARCHAR(100), status NVARCHAR(20),
 *                            invited_by UNIQUEIDENTIFIER, invited_at,
 *                            accepted_at)
 *
 * Upsert key: (tenant_id, email, status='pending'). Re-running the upsert
 * just refreshes invited_at — no duplicate pending rows.
 *
 * Notes
 * -----
 * - Email is lowercased before insert; platform-api compares with LOWER() in
 *   its claim query, so both sides agree.
 * - role_key defaults to 'owner' — Path A buyers are the owner of the new
 *   tenant they just paid for. Callers can override.
 * - invited_by is optional. For Path A there is no inviting user; we pass
 *   null and the column accepts it.
 * - We do NOT apply the founder-team email guard here. That guard exists in
 *   Path B because the wizard sometimes auto-prefilled the founder's own
 *   email by accident; Path A's email comes from the Stripe-checkout buyer
 *   typing it themselves, so they're either the founder legitimately
 *   provisioning a new tenant or a real customer — both should claim.
 */

import sql from 'mssql';

export async function upsertTenantInvitation(platformPool, {
  tenantId,
  email,
  roleKey = 'owner',
  invitedBy = null,
}) {
  if (!tenantId || !email) {
    throw new Error('upsertTenantInvitation requires tenantId + email');
  }
  const lowerEmail = String(email).toLowerCase().trim();
  await platformPool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('email', sql.NVarChar(320), lowerEmail)
    .input('role_key', sql.NVarChar(100), roleKey)
    .input('invited_by', sql.UniqueIdentifier, invitedBy || null)
    .query(`
      IF EXISTS (
        SELECT 1 FROM core.tenant_invitations
         WHERE tenant_id=@tenant_id AND LOWER(email)=@email AND status='pending'
      )
        UPDATE core.tenant_invitations
           SET role_key=@role_key, invited_by=@invited_by, invited_at=SYSUTCDATETIME()
         WHERE tenant_id=@tenant_id AND LOWER(email)=@email AND status='pending';
      ELSE
        INSERT INTO core.tenant_invitations
          (tenant_id, email, role_key, status, invited_by)
        VALUES
          (@tenant_id, @email, @role_key, 'pending', @invited_by);
    `);
}
