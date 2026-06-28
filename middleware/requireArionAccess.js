import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";
import { getEmailFromClaims, getExternalSubject } from "../lib/claims.js";

async function getIdentityProviderId(platformPool, providerKey) {
  const result = await platformPool
    .request()
    .input("provider_key", sql.NVarChar(100), providerKey)
    .query(`
      SELECT TOP 1 identity_provider_id
      FROM core.identity_providers
      WHERE provider_key = @provider_key
        AND is_active = 1;
    `);

  return result.recordset[0]?.identity_provider_id || null;
}

async function resolvePlatformUser(platformPool, claims) {
  const providerKey = (process.env.AUTH_PROVIDER_KEY || "external_entra").trim();
  const identityProviderId = await getIdentityProviderId(platformPool, providerKey);
  if (!identityProviderId) {
    throw new Error("Identity provider not configured (core.identity_providers missing provider_key)");
  }

  const externalSubject = getExternalSubject(claims);
  const email = getEmailFromClaims(claims);

  const request = platformPool
    .request()
    .input("identity_provider_id", sql.UniqueIdentifier, identityProviderId)
    .input("external_subject", sql.NVarChar(400), externalSubject)
    .input("email", sql.NVarChar(320), email);

  const result = await request.query(`
    SELECT TOP 1 user_id, email, first_name, last_name, full_name
    FROM core.users
    WHERE (
      @external_subject IS NOT NULL
      AND identity_provider_id = @identity_provider_id
      AND external_subject = @external_subject
    )
    OR (
      @email IS NOT NULL
      AND LOWER(email) = LOWER(@email)
    );
  `);

  return result.recordset[0] || null;
}

export async function requireArionAccess(req, res, next) {
  try {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: "Tenant not resolved" });
    }

    const platformPool = await getPlatformPool();
    const user = await resolvePlatformUser(platformPool, req.auth);

    if (!user?.user_id) {
      return res.status(403).json({ error: "Not authorized", details: "User was not found in iadm_platform." });
    }

    // Membership check accepts EITHER direct membership in the target tenant
    // OR membership in the founder tenant (iadm). The founder can operate on
    // any client tenant by setting x-tenant-key. Audit columns still stamp
    // the founder's identity.
    const founderTenantId = (process.env.FOUNDER_TENANT_ID || "8C9527B9-8999-4B31-A306-F3D4CCC39FBD").trim().toUpperCase();
    const membership = await platformPool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("founder_tenant_id", sql.UniqueIdentifier, founderTenantId || tenantId)
      .input("user_id", sql.UniqueIdentifier, user.user_id)
      .query(`
        SELECT TOP 1 tenant_user_id, tenant_id AS matched_tenant_id
        FROM core.tenant_users
        WHERE user_id = @user_id
          AND tenant_id IN (@tenant_id, @founder_tenant_id)
          AND (status IS NULL OR status = 'active')
        ORDER BY CASE WHEN tenant_id = @tenant_id THEN 0 ELSE 1 END;
      `);

    const row = membership.recordset[0];
    let tenantUserId = row?.tenant_user_id || null;
    let isFounderActingOnClient = row && String(row.matched_tenant_id).toUpperCase() === founderTenantId
                                          && String(tenantId).toUpperCase() !== founderTenantId;
    let actingAsConsultant = false;

    // 2026-06-27 — consultant_grant fallback. IA team members consulting on
    // client tenants get access via core.consultant_grant. See memory:
    // consultant-grant-model.
    if (!tenantUserId) {
      const grant = await platformPool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, tenantId)
        .input("user_id", sql.UniqueIdentifier, user.user_id)
        .query(`
          SELECT TOP 1 consultant_grant_id, role_key, access_level
            FROM core.consultant_grant
           WHERE consultant_user_id = @user_id
             AND client_tenant_id   = @tenant_id
             AND is_active          = 1
             AND (revoked_at IS NULL OR revoked_at > SYSUTCDATETIME());
        `);
      if (grant.recordset[0]) {
        actingAsConsultant = true;
        isFounderActingOnClient = true;
      }
    }

    if (!tenantUserId && !actingAsConsultant) {
      return res.status(403).json({ error: "Not authorized", details: "User is not a member of the selected tenant." });
    }
    req.isFounderActingOnClient = isFounderActingOnClient;
    req.actingAsConsultant = actingAsConsultant;
    req.consultantOrg = actingAsConsultant ? 'Intelligent Analytics' : null;

    const serviceKey = (process.env.ARION_SERVICE_KEY || "arion").trim();
    const entitlement = await platformPool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("service_key", sql.NVarChar(100), serviceKey)
      .query(`
        SELECT TOP 1 s.service_id, s.service_key, s.name
        FROM core.tenant_services ts
        JOIN core.services s
          ON s.service_id = ts.service_id
        WHERE ts.tenant_id = @tenant_id
          AND ts.is_enabled = 1
          AND s.is_active = 1
          AND LOWER(s.service_key) = LOWER(@service_key);
      `);

    const service = entitlement.recordset[0] || null;
    if (!service) {
      return res.status(403).json({ error: "ARION is not enabled for this tenant." });
    }

    req.platformUser = {
      userId: user.user_id,
      tenantUserId,
      email: user.email,
      displayName: user.full_name,
    };
    req.service = {
      serviceId: service.service_id,
      serviceKey: service.service_key,
      name: service.name,
    };

    return next();
  } catch (err) {
    console.error("[requireArionAccess] error:", err);
    return res.status(500).json({ error: "Failed to authorize ARION access", details: err.message });
  }
}
