// lib/consultingAccess.js — Consulting Access guard for arion-api.
//
// No-op unless an `x-acting-tenant` header is present (an IA consulting
// session). When present the operator must be a platform SUPER_ADMIN or hold
// an ACTIVE, unexpired core.consulting_access_grant for that client tenant.
// On success req.tenant is rewritten to the client tenant + consulting
// context + audit attached. Mirrors oliver-api/platform-api.
import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";
import { getEmailFromClaims } from "./claims.js";

async function isPlatformAdmin(pool, email) {
  if (!email) return false;
  const r = await pool.request()
    .input("email", sql.NVarChar(320), email.toLowerCase())
    .query(`
      SELECT TOP 1 1 ok
      FROM core.users u
      JOIN core.user_platform_roles upr ON upr.user_id=u.user_id AND upr.is_active=1
      JOIN core.platform_roles pr ON pr.platform_role_id=upr.platform_role_id AND pr.is_active=1
      WHERE LOWER(u.email)=@email AND pr.name IN ('SUPER_ADMIN')`);
  return r.recordset.length > 0;
}

async function findActiveGrant(pool, email, clientTenantId) {
  const r = await pool.request()
    .input("email", sql.NVarChar(320), email.toLowerCase())
    .input("tid", sql.UniqueIdentifier, clientTenantId)
    .query(`
      SELECT TOP 1 operator_role, scope, engagement_id
      FROM core.consulting_access_grant
      WHERE LOWER(operator_email)=@email AND client_tenant_id=@tid
        AND status='active'
        AND (expires_at IS NULL OR expires_at > SYSUTCDATETIME())
      ORDER BY created_at DESC`);
  return r.recordset[0] || null;
}

async function audit(pool, { tenantId, email, action, summary, metadata, ip, ua }) {
  try {
    await pool.request()
      .input("tenantId", sql.UniqueIdentifier, tenantId)
      .input("email", sql.NVarChar(320), email || null)
      .input("action", sql.NVarChar(80), action)
      .input("summary", sql.NVarChar(500), (summary || "").slice(0, 500))
      .input("meta", sql.NVarChar(sql.MAX), metadata ? JSON.stringify(metadata) : null)
      .input("ip", sql.NVarChar(50), ip || null)
      .input("ua", sql.NVarChar(500), (ua || "").slice(0, 500))
      .query(`
        INSERT INTO platform.audit_log
          (tenant_id, user_email, product, action, summary, metadata_json, ip_address, user_agent)
        VALUES (@tenantId, @email, 'arion', @action, @summary, @meta, @ip, @ua)`);
  } catch (e) {
    console.warn("[arion consultingAccess] audit failed:", e.message);
  }
}

/** On-artifact attribution label for consulting-session work, else null. */
export function attributionLabel(req) {
  if (!req?.isConsultingSession) return null;
  return `Intelligent Analytics — ${req.actingOperatorEmail || "operator"}`;
}

export async function actingTenantGuard(req, res, next) {
  try {
    const actingRaw = req.header("x-acting-tenant");
    if (!actingRaw || !actingRaw.trim()) return next();

    const actingTenantId = actingRaw.trim();
    const email = getEmailFromClaims(req.auth) || req.header("x-user-email") || null;
    if (!email) return res.status(403).json({ error: "consulting_no_identity" });

    const pool = await getPlatformPool();
    const admin = await isPlatformAdmin(pool, email);
    const grant = admin ? null : await findActiveGrant(pool, email, actingTenantId);
    if (!admin && !grant) {
      await audit(pool, { tenantId: actingTenantId, email, action: "consulting.access_denied",
        summary: `Denied ARION acting access to ${actingTenantId}`, ip: req.ip, ua: req.header("user-agent") });
      return res.status(403).json({ error: "consulting_not_authorized" });
    }

    const t = await pool.request()
      .input("tid", sql.UniqueIdentifier, actingTenantId)
      .query(`SELECT TOP 1 tenant_id, name, full_name, subscription_tier
              FROM core.tenants WHERE tenant_id=@tid`);
    if (!t.recordset.length) return res.status(404).json({ error: "acting_tenant_not_found" });
    const row = t.recordset[0];

    req.tenant = {
      tenantId: row.tenant_id,
      tenantName: row.name,
      tenantFullName: row.full_name,
      resolvedBy: "consulting_acting_tenant",
    };
    if (row.subscription_tier) req.tenantTier = String(row.subscription_tier).toLowerCase();
    req.isConsultingSession = true;
    req.actingOperatorEmail = email;
    req.consultingOperatorRole = admin ? "platform_admin" : (grant.operator_role || "consultant");
    req.consultingScope = admin ? "full" : (grant.scope || "full");
    req.consultingEngagementId = grant?.engagement_id || req.header("x-engagement-id") || null;

    if (req.method !== "GET" || req.consultingEngagementId) {
      await audit(pool, {
        tenantId: row.tenant_id, email, action: "consulting.access",
        summary: `${req.consultingOperatorRole} ${req.method} ${req.originalUrl}`,
        metadata: { scope: req.consultingScope, engagement_id: req.consultingEngagementId },
        ip: req.ip, ua: req.header("user-agent"),
      });
    }
    return next();
  } catch (err) {
    console.error("[arion actingTenantGuard] error:", err);
    return res.status(500).json({ error: "consulting_guard_failed", details: err.message });
  }
}
