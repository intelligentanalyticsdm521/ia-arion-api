// middleware/requireArionTenantAdmin.js
//
// Tier 3-3b for ARION (roles enforcement, 2026-07-04). Mirror of oliver-api's
// requireTenantAdmin: gate MUTATIONS on tenant-admin config surfaces (integrations,
// Google/Bing connect, GBP, plugin config, SEO reconfigure) on the PLATFORM tenant
// role (req.tenantRole, stamped by requireArionAccess: admin|user|read_only). Reads
// are always allowed — a `user` can VIEW but not change ARION config.
//
// BYTE-SAFE: every existing user defaults to `admin` (no explicit row), so this
// passes for everyone today EXCEPT users with an explicit `user`/`read_only` row.
// Founder/consultant acting on a client is bypassed. Fail-OPEN if req.tenantRole is
// unset (only used after requireArionAccess, which always stamps it) so it can never
// lock out an admin.
export function requireArionTenantAdmin(req, res, next) {
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes((req.method || "GET").toUpperCase());
  if (!isMutation) return next();                    // reads always allowed
  if (req.isFounderActingOnClient) return next();    // founder/consultant bypass
  if (req.tenantRole && req.tenantRole !== "admin") {
    return res.status(403).json({
      error: "tenant_admin_required",
      details: "Only a business admin can change this ARION setting. Ask an admin on your team.",
    });
  }
  return next(); // tenantRole unset (shouldn't happen post-requireArionAccess) → fail-open
}
