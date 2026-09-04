// middleware/enforceViewAsReadOnly.js
//
// Founder "View as tenant" read-only enforcement — arion-api copy.
// Mirrors oliver-api/middleware/enforceViewAsReadOnly.js.
//
// Companion to enforceEmergencyReadOnly, but for the routine walk-through-
// with-a-client surface, not the break-glass surface. Differences vs
// enforceEmergencyReadOnly:
//
//   - Header is x-view-as-mode: read_only (NOT x-actas-mode: emergency)
//   - No 30-minute timer; founder stays in view-as until they click Exit
//   - No core.tenant_actas_log row required; no audit row mutation
//   - Verifies founder identity by checking core.tenant_users membership
//     in the founder tenant (FOUNDER_TENANT_ID) — reuses the EXACT bypass
//     pattern requireArionAccess already uses. NO new role / grant tables.
//
// Behavior:
//   1. If x-view-as-mode header is not 'read_only', this middleware is a no-op.
//   2. Otherwise verify the caller's JWT resolves to a user that holds an
//      ACTIVE membership in the founder tenant. Non-founders that try to
//      forge this header are 403'd.
//   3. Block any non-GET / non-HEAD / non-OPTIONS request with 403.
//   4. GET requests pass through; the route handler still serves the client
//      tenant identified by x-tenant-key (per the existing founder-bypass
//      in requireArionAccess).
//
// CONSTRAINT (per scope): MUST NOT break normal traffic. If x-view-as-mode
// is absent, this is a no-op pass-through.

import { resolveFounderFacts, FounderUnavailable } from "../lib/founderClient.js";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// arion-api specifics: keep the same plugin-poll allowlist as
// enforceEmergencyReadOnly so the IA plugin keeps working — though plugin
// callers will never send the x-view-as-mode header (it's Portal-only), this
// keeps the carve-out shape identical between the two middlewares.
const ALWAYS_ALLOWED_NON_GET_PATHS = [
  "/super/end-session",
  "/session/verify",
  "/session/select-tenant",
  "/plugin/manifest",
  "/plugin/download",
];

function isAlwaysAllowedNonGet(req) {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  return ALWAYS_ALLOWED_NON_GET_PATHS.some((p) => path === p || path.endsWith(p));
}

function decodeJwtClaimsUnverified(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice((payload.length + 3) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getClaims(req) {
  if (req.auth && typeof req.auth === "object") return req.auth;
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return decodeJwtClaimsUnverified(token);
}

/**
 * Is this caller IA staff?
 *
 * SEAMS PACK 4B — one call to the ONE answer, and the 60-second cache moved
 * into lib/founderClient.js with the question it caches. `is_founder_team` is
 * active membership of the founder tenant: exactly the row the deleted SQL
 * selected, and exactly the population view-as has always admitted.
 *
 * FAILS CLOSED, and says which kind of closed: a real "no" is 403, no answer
 * at all is 503 + retryable (it was 500).
 */
async function resolveIsFounder(req) {
  const claims = req.auth || null;
  if (!claims) return { ok: false, status: 401, reason: "unauthenticated" };
  try {
    const facts = await resolveFounderFacts(claims);
    return { ok: true, isFounder: !!facts.is_founder_team };
  } catch (err) {
    if (err instanceof FounderUnavailable || err?.name === "FounderUnavailable") {
      console.error("[enforceViewAsReadOnly] founder lookup unavailable:", err.message);
      return { ok: false, status: 503, reason: "founder_lookup_unavailable", details: err.reason };
    }
    throw err;
  }
}

export function enforceViewAsReadOnly() {
  return async function viewAsReadOnlyMiddleware(req, res, next) {
    const mode = String(req.headers["x-view-as-mode"] || "").toLowerCase().trim();
    if (mode !== "read_only") return next();

    const r = await resolveIsFounder(req);
    if (!r.ok) {
      return res.status(r.status || 500).json({
        error: "view_as_forbidden",
        reason: r.reason,
        details: r.details,
      });
    }
    if (!r.isFounder) {
      return res.status(403).json({
        error: "view_as_forbidden",
        reason: "not_founder",
        message: "View-as mode requires founder membership.",
      });
    }

    if (!READ_ONLY_METHODS.has(req.method) && !isAlwaysAllowedNonGet(req)) {
      return res.status(403).json({
        error: "view_as_read_only",
        message: "View-as is read-only — exit view-as to make changes.",
      });
    }

    req.viewAsReadOnly = true;
    req.viewAsTenantId = String(req.headers["x-view-as-tenant"] || "").trim() || null;
    return next();
  };
}
