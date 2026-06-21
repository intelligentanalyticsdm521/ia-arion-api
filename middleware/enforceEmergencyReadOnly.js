// middleware/enforceEmergencyReadOnly.js
//
// Founder super-user "Emergency act-as" (Design Option D, Phase 2) read-only
// enforcement — arion-api copy. Mirrors oliver-api/middleware/enforceEmergencyReadOnly.js
// (oliver-api commit 4c96870). Logic:
//
//   1. Look up the founder's currently active emergency session row in
//      core.tenant_actas_log (latest unended row for this founder).
//   2. Auto-expire the row if expires_at < now (sets ended_at) and return
//      419 "Session expired" so the Portal can drop emergency mode.
//   3. Reject all non-GET requests with 403, except an explicit allowlist
//      (see ALWAYS_ALLOWED_NON_GET_PATHS) — which on arion-api adds
//      /plugin/manifest + /plugin/download so the IA Plugin keeps polling
//      and updating during emergency mode.
//   4. Increment request_count on the active row (best-effort, non-fatal).
//
// CONSTRAINT (per scope): MUST NOT break normal traffic. The check is
// strictly opt-in by header: if x-actas-mode !== 'emergency', this middleware
// is a no-op.
//
// CROSS-REPO DEPENDENCY: core.tenant_actas_log lives in iadm_platform and the
// migration ships with oliver-api (oliver-api/db/migrations/092_tenant_actas_log.sql).
// arion-api connects to the same platform DB via getPlatformPool(). If the
// table is missing (migration hasn't been applied yet to this environment)
// we FAIL OPEN with a console.warn rather than crashing — emergency mode is a
// founder-only convenience and arion-api must keep serving regular client
// traffic regardless.

import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";

// Methods that are always allowed in emergency mode.
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Path suffixes that are allowed even on non-GET methods.
//
// arion-api specifics:
//   - /super/end-session  ........ founder voluntary exit (parity with oliver-api)
//   - /session/verify, /session/select-tenant  ... auth-refresh carve-outs
//     (kept for parity — these actually live on platform-api)
//   - /plugin/manifest  .......... IA Plugin polls this every page-load to
//                                  check for updates; must always work
//   - /plugin/download  .......... IA Plugin update fetch; ditto
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

// Lightweight JWT claims decoder (NO signature verification — we use this only
// to identify the founder for the lookup in core.tenant_actas_log; the actual
// auth check happens in requireAuth which has already run before us in the
// arion chain). This matches oliver-api's `req.auth || null` access but adds
// a fallback for the (unlikely) case that this middleware is mounted on a
// chain without requireAuth.
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

// Track once-per-process whether core.tenant_actas_log exists. If a query
// fails with a "missing object" error we flip this to true and fail open on
// every subsequent request without re-querying.
let tableMissingLogged = false;

function isMissingTableError(err) {
  const msg = (err && err.message) || "";
  // SQL Server: 208 = "Invalid object name", 207 = "Invalid column name".
  return (
    err?.number === 208 ||
    /Invalid object name/i.test(msg) ||
    /tenant_actas_log/i.test(msg) && /Invalid/i.test(msg)
  );
}

export function enforceEmergencyReadOnly({ getPool = getPlatformPool } = {}) {
  return async function emergencyReadOnlyMiddleware(req, res, next) {
    // OPT-IN: only engage when the Portal explicitly signals emergency mode.
    const mode = String(req.headers["x-actas-mode"] || "").toLowerCase().trim();
    if (mode !== "emergency") return next();

    const claims = getClaims(req);
    if (!claims) {
      return res.status(401).json({
        error: "unauthenticated",
        message: "Emergency mode requires an authenticated request.",
      });
    }

    try {
      const p = await getPool();

      const email = (
        claims.email ||
        claims.preferred_username ||
        claims.upn ||
        (Array.isArray(claims.emails) ? claims.emails[0] : null) ||
        ""
      )
        .toString()
        .trim()
        .toLowerCase();
      const externalSubject = (claims.oid || claims.sub || "").toString().trim();

      if (!email && !externalSubject) {
        return res.status(403).json({
          error: "forbidden",
          message: "Emergency mode requires identifiable founder claims.",
        });
      }

      const idRes = await p
        .request()
        .input("email", sql.NVarChar(320), email || null)
        .input("external_subject", sql.NVarChar(400), externalSubject || null)
        .query(`
          SELECT TOP 1 user_id
          FROM core.users
          WHERE (@external_subject IS NOT NULL AND external_subject = @external_subject)
             OR (@email IS NOT NULL AND LOWER(email) = @email)
          ORDER BY CASE WHEN external_subject = @external_subject THEN 0 ELSE 1 END;
        `);

      const founderUserId = idRes.recordset[0]?.user_id;
      if (!founderUserId) {
        return res.status(403).json({
          error: "forbidden",
          message: "Emergency mode claimed, but founder identity not resolved.",
        });
      }

      const sessRes = await p
        .request()
        .input("founder_user_id", sql.UniqueIdentifier, founderUserId)
        .query(`
          SELECT TOP 1
            actas_log_id,
            tenant_id,
            started_at,
            expires_at,
            ended_at
          FROM core.tenant_actas_log
          WHERE founder_user_id = @founder_user_id
            AND mode = 'emergency'
            AND ended_at IS NULL
          ORDER BY started_at DESC;
        `);

      const sess = sessRes.recordset[0];
      if (!sess) {
        return res.status(419).json({
          error: "emergency_session_expired",
          message: "No active emergency session found. Exit emergency mode and try again.",
        });
      }

      const now = Date.now();
      const expiresAtMs = sess.expires_at ? new Date(sess.expires_at).getTime() : null;
      if (expiresAtMs && expiresAtMs < now) {
        try {
          await p
            .request()
            .input("actas_log_id", sql.BigInt, sess.actas_log_id)
            .query(`
              UPDATE core.tenant_actas_log
              SET ended_at = SYSUTCDATETIME()
              WHERE actas_log_id = @actas_log_id
                AND ended_at IS NULL;
            `);
        } catch (err) {
          console.error("[enforceEmergencyReadOnly] auto-end failed (non-fatal):", err.message);
        }
        return res.status(419).json({
          error: "emergency_session_expired",
          message: "Emergency session expired. Exit emergency mode and re-authenticate.",
        });
      }

      if (!READ_ONLY_METHODS.has(req.method) && !isAlwaysAllowedNonGet(req)) {
        return res.status(403).json({
          error: "emergency_read_only",
          message: "Emergency mode is read-only — exit emergency mode to make changes.",
        });
      }

      try {
        await p
          .request()
          .input("actas_log_id", sql.BigInt, sess.actas_log_id)
          .query(`
            UPDATE core.tenant_actas_log
            SET request_count = request_count + 1
            WHERE actas_log_id = @actas_log_id;
          `);
      } catch (err) {
        console.warn("[enforceEmergencyReadOnly] request_count bump failed:", err.message);
      }

      req.emergencyActAs = {
        actas_log_id: sess.actas_log_id,
        founder_user_id: founderUserId,
        tenant_id: sess.tenant_id,
        started_at: sess.started_at,
        expires_at: sess.expires_at,
      };

      return next();
    } catch (err) {
      // FAIL OPEN on missing-table — this is the cross-repo dependency case
      // where oliver-api's migration 092 hasn't run yet against this env. We
      // log once and let the request through so we don't break normal traffic.
      if (isMissingTableError(err)) {
        if (!tableMissingLogged) {
          console.warn(
            "[enforceEmergencyReadOnly] core.tenant_actas_log is missing on the platform DB " +
              "(oliver-api migration 092 not applied?). Failing open — emergency mode will not " +
              "be enforced on this environment until the table exists. Original error: " +
              err.message
          );
          tableMissingLogged = true;
        }
        return next();
      }
      console.error("[enforceEmergencyReadOnly] error:", err);
      return res.status(500).json({
        error: "emergency_check_failed",
        details: err.message,
      });
    }
  };
}
