// middleware/tenantResolution.js
import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";

function isGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
}

/**
 * Tenant Resolution Middleware (Header-only)
 *
 * Requires:
 *   - x-tenant-key header
 *
 * x-tenant-key can be either:
 *   1) tenant_id GUID (recommended)
 *   2) tenant name (matches core.tenants.name OR full_name, case-insensitive)
 *
 * Attaches:
 *   req.tenant = {
 *     tenantId,
 *     tenantName,
 *     tenantFullName,
 *     resolvedBy: "tenant_id" | "name"
 *   }
 */
export async function tenantResolution(req, res, next) {
  try {
    const tenantKeyRaw = req.header("x-tenant-key") || null;

    if (!tenantKeyRaw || !tenantKeyRaw.trim()) {
      return res.status(400).json({
        error: "Missing tenant identifier",
        details: "Provide x-tenant-key header (recommended: the tenant_id GUID).",
      });
    }

    const input = tenantKeyRaw.trim();
    const platformPool = await getPlatformPool();

    let r;

    // 1) GUID -> resolve by tenant_id
    if (isGuid(input)) {
      r = await platformPool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, input)
        .query(`
          SELECT TOP 1 tenant_id, name, full_name
          FROM core.tenants
          WHERE tenant_id = @tenant_id;
        `);

      if (!r.recordset.length) {
        return res.status(404).json({ error: "Tenant not found for tenant_id", tenantId: input });
      }

      const row = r.recordset[0];
      req.tenant = {
        tenantId: row.tenant_id,
        tenantName: row.name,
        tenantFullName: row.full_name,
        resolvedBy: "tenant_id",
      };
      return next();
    }

    // 2) String -> resolve by name/full_name
    r = await platformPool
      .request()
      .input("tenant_name", sql.NVarChar(200), input)
      .query(`
        SELECT TOP 1 tenant_id, name, full_name
        FROM core.tenants
        WHERE LOWER(name) = LOWER(@tenant_name)
           OR LOWER(full_name) = LOWER(@tenant_name);
      `);

    if (!r.recordset.length) {
      return res.status(404).json({
        error: "Tenant not found for x-tenant-key (name/full_name)",
        tenantKey: input,
      });
    }

    const row = r.recordset[0];
    req.tenant = {
      tenantId: row.tenant_id,
      tenantName: row.name,
      tenantFullName: row.full_name,
      resolvedBy: "name",
    };

    return next();
  } catch (err) {
    console.error("[tenantResolution] error:", err);
    return res.status(500).json({ error: "Failed to resolve tenant", details: err.message });
  }
}
