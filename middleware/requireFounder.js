// middleware/requireFounder.js — the founder gate the Portal can actually use.
//
// arion-api's only founder gate was a static bearer (FOUNDER_ADMIN_TOKEN,
// routes/admin/onboardExisting.js). That works for a script or a curl, but a
// browser page cannot hold it — shipping it in the Portal bundle would publish
// the secret to every visitor. So the founder queue page had no way in.
//
// This accepts EITHER:
//   1. the static FOUNDER_ADMIN_TOKEN bearer — unchanged, so the onboard
//      script and any server-to-server caller keep working; or
//   2. a normal Portal sign-in whose user holds an ACTIVE founder /
//      super_admin platform role in iadm_platform.
//
// (2) is the same question platform-api's isFounderCaller asks
// (core.user_platform_roles + core.platform_roles) and the same one
// scripts/onboard-client.js asks before refusing to link a founder to a client
// tenant — one answer to "is this person the founder", not a third one.
// Per reference_role_access_model the gate is FOUNDER, not "super user in the
// UI sense"; the Portal mirrors it with RequireFounderRoute so a client never
// sees the page, and this middleware is what actually stops them.
//
// Deliberately NOT tenant-scoped: the queue spans every business, so there is
// no x-tenant-key to resolve and requireArionAccess does not apply.
import sql from "mssql";
import { requireAuth } from "./requireAuth.js";
import { getPlatformPool } from "../db/platformPool.js";
import { getEmailFromClaims, getExternalSubject } from "../lib/claims.js";

/** Bearer matches the static founder token. False when the token is unset. */
export function matchesFounderAdminToken(req) {
  const expected = process.env.FOUNDER_ADMIN_TOKEN || "";
  if (!expected) return false;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") && h.slice(7) === expected;
}

/**
 * Does the signed-in caller hold an active founder / super-admin platform
 * role? Returns the matching row or null. Same shape as
 * scripts/onboard-client.js's founderCheck — keep them in step.
 */
export async function findFounderRole(pool, claims) {
  const externalSubject = getExternalSubject(claims || {});
  const email = getEmailFromClaims(claims || {});
  if (!externalSubject && !email) return null;
  const r = await pool.request()
    .input("sub", sql.NVarChar(400), externalSubject)
    .input("email", sql.NVarChar(320), email)
    .query(`
      SELECT TOP 1 u.user_id, u.email, u.full_name, pr.role_key
        FROM core.users u
        JOIN core.user_platform_roles upr
          ON upr.user_id = u.user_id AND upr.is_active = 1
        JOIN core.platform_roles pr
          ON pr.platform_role_id = upr.platform_role_id AND pr.is_active = 1
       WHERE (
               (@sub IS NOT NULL AND u.external_subject = @sub)
            OR (@email IS NOT NULL AND LOWER(u.email) = LOWER(@email))
             )
         AND (pr.role_key IN ('founder', 'super_admin') OR pr.name = 'SUPER_ADMIN')
    `);
  return r.recordset[0] || null;
}

/**
 * The half that runs AFTER requireAuth has proved who the caller is.
 *
 * A caller who is signed in but not a founder gets 403 (they exist, they are
 * simply not allowed) — never a 401, which would send the Portal off to
 * re-authenticate in a loop. A lookup failure is a 500, never a quiet pass:
 * an unreachable platform DB must not open the queue to everyone.
 *
 * Exported with an injectable pool so the refusal can be tested without a
 * database — every dev fixture user carries the founder role, so dev traffic
 * cannot exercise the refusal on its own.
 */
export async function founderRoleGate(req, res, next, poolFactory = getPlatformPool) {
  try {
    const pool = await poolFactory();
    const founder = await findFounderRole(pool, req.auth);
    if (!founder) {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: "Founder access required", status: 403 },
      });
    }
    req.founderAuth = { via: "platform_role", userId: founder.user_id, email: founder.email, roleKey: founder.role_key };
    return next();
  } catch (err) {
    console.error("[requireFounder] role lookup failed:", err.message);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Could not verify founder access", status: 500 },
    });
  }
}

/** Gate: static founder token OR a founder-role Portal sign-in. */
export function requireFounder(req, res, next) {
  if (matchesFounderAdminToken(req)) {
    req.founderAuth = { via: "admin_token" };
    return next();
  }
  // requireAuth answers 401 itself when the token is missing or invalid.
  return requireAuth(req, res, () => founderRoleGate(req, res, next));
}
