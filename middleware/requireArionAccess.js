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
    // P1-2 (Agency Foundation) — DUAL-READ window. Accept EITHER the legacy
    // FOUNDER_TENANT_ID arm OR the generalized `tenant_kind='platform_owner'`
    // arm. IA is BOTH today (byte-identical); the platform_owner arm only adds
    // forward-compat. Logs which arm fired before P1-3 removes the GUID arm.
    const membership = await platformPool
      .request()
      .input("tenant_id", sql.UniqueIdentifier, tenantId)
      .input("founder_tenant_id", sql.UniqueIdentifier, founderTenantId || tenantId)
      .input("user_id", sql.UniqueIdentifier, user.user_id)
      .query(`
        SELECT TOP 1 tu.tenant_user_id, tu.tenant_id AS matched_tenant_id,
               t.tenant_kind AS matched_kind, t.provider_tenant_id AS matched_provider
        FROM core.tenant_users tu
        JOIN core.tenants t ON t.tenant_id = tu.tenant_id
        WHERE tu.user_id = @user_id
          AND (tu.status IS NULL OR tu.status = 'active')
          AND (tu.tenant_id = @tenant_id
               OR tu.tenant_id = @founder_tenant_id
               OR t.tenant_kind = 'platform_owner')
        ORDER BY CASE WHEN tu.tenant_id = @tenant_id THEN 0
                      WHEN tu.tenant_id = @founder_tenant_id THEN 1
                      ELSE 2 END;
      `);

    const row = membership.recordset[0];
    let tenantUserId = row?.tenant_user_id || null;
    const matchedTenantUpper = row ? String(row.matched_tenant_id).toUpperCase() : null;
    const targetUpper = String(tenantId).toUpperCase();
    const actingViaFounderGuid = !!row && matchedTenantUpper === founderTenantId && targetUpper !== founderTenantId;
    const actingViaPlatformOwner = !!row && row.matched_kind === "platform_owner" && matchedTenantUpper !== targetUpper;
    let isFounderActingOnClient = actingViaFounderGuid || actingViaPlatformOwner;
    let actingAsConsultant = false;
    if (isFounderActingOnClient) {
      const arm = actingViaFounderGuid
        ? (actingViaPlatformOwner ? "founder_guid+platform_owner" : "founder_guid")
        : "platform_owner";
      console.log(`[access-dualread:arion] user=${user.user_id} target=${tenantId} arm=${arm}`);
    }

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
    // P1-3 (Agency Foundation) — generalized provider context (byte-identical
    // today; forward-compatible for multi-agency).
    req.isProvider = row?.matched_kind === "platform_owner" || row?.matched_kind === "agency";
    req.actorProviderTenantId = row?.matched_provider || null;
    // P1-4 (Agency Foundation) — provider catalog scope (mirror of oliver-api;
    // arion-api has no consulting catalog reads today but keeps the stamp
    // identical to avoid mirror-file drift). See requireOliverAccess.js.
    req.actorProviderScopeTenantId = req.isProvider
      ? (row?.matched_tenant_id || null)
      : (row?.matched_provider || null);

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

    // ── Tier 3-3a (roles enforcement, 2026-07-04) — BYTE-SAFE primitive ──
    // Mirror of requireOliverAccess.js. Resolve the platform TENANT role
    // (core.tenant_user_role: admin|user|read_only) + the per-user product gate
    // (core.tenant_user_product_access, product_key='arion'). Both default to
    // admin/allow when no row exists → byte-identical for every existing user.
    // Founder/consultant acting on a client has no row → admin + full access.
    // FAIL-OPEN on any error so a transient DB hiccup can never lock a tenant out.
    let tenantRole = "admin";
    let productDenied = false;
    try {
      const roleR = await platformPool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, tenantId)
        .input("user_id", sql.UniqueIdentifier, user.user_id)
        .query(`
          SELECT
            (SELECT TOP 1 role FROM core.tenant_user_role
               WHERE tenant_id = @tenant_id AND user_id = @user_id) AS role,
            (SELECT TOP 1 can_access FROM core.tenant_user_product_access
               WHERE tenant_id = @tenant_id AND user_id = @user_id
                 AND product_key = 'arion') AS can_access;
        `);
      const rr = roleR.recordset[0] || {};
      if (rr.role === "user" || rr.role === "read_only") tenantRole = rr.role;
      if (rr.can_access === false || rr.can_access === 0) productDenied = true;
    } catch (e) {
      console.warn("[requireArionAccess] role/product read failed; defaulting to admin/allow:", e.message);
      tenantRole = "admin";
      productDenied = false;
    }
    req.tenantRole = tenantRole;
    if (productDenied && !isFounderActingOnClient) {
      return res.status(403).json({
        error: "product_access_denied",
        details: "Your account has not been granted access to ARION for this business.",
      });
    }
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes((req.method || "GET").toUpperCase());
    if (tenantRole === "read_only" && isMutation && !isFounderActingOnClient) {
      return res.status(403).json({
        error: "read_only",
        details: "Your account has read-only access to this business.",
      });
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
