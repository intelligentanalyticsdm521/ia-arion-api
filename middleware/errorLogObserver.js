// middleware/errorLogObserver.js — Sept 2026 Release A (F7).
//
// Passive response-finish observer: every response with status >= 400 lands a
// row in core.error_log (iadm_services). This is deliberately NOT an error
// handler — most 4xx/5xx on this API are returned via res.status().json()
// and never pass through error middleware, which is why RII's failed
// attempts left no trace anywhere.
//
// Guarantees: never blocks the response, never throws into the request path,
// never mutates the response body. Sets x-request-id on every request so a
// client screenshot can be correlated to its row.
import crypto from "node:crypto";
import sql from "mssql";
import { getServicesPool } from "../db/servicesPool.js";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveTenant(req) {
  const t = req.tenant?.tenantId || req.header?.("x-tenant-id") || req.header?.("x-tenant-key") || null;
  return t && GUID_RE.test(String(t)) ? String(t) : null;
}

function resolveEmail(req) {
  return (
    req.platformUser?.email ||
    req.auth?.email ||
    req.auth?.preferred_username ||
    (Array.isArray(req.auth?.emails) ? req.auth.emails[0] : null) ||
    null
  );
}

function extractErrorInfo(body) {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const code = body.error_code || body.code || (typeof body.error === "string" ? body.error : null);
  const message =
    body.message ||
    (typeof body.error === "object" ? body.error?.message : null) ||
    (typeof body.error === "string" && body.error.length > 40 ? body.error : null);
  return {
    code: code ? String(code).slice(0, 100) : null,
    message: message ? String(message).slice(0, 2000) : null,
  };
}

export function errorLogObserver(api) {
  return (req, res, next) => {
    const requestId = crypto.randomUUID();
    res.setHeader("x-request-id", requestId);

    // Capture the JSON body reference for >=400 responses without copying it.
    const origJson = res.json.bind(res);
    res.json = (body) => {
      res.locals._errLogBody = body;
      return origJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 400) return;
      const status = res.statusCode;
      const method = String(req.method || "").slice(0, 10);
      const path = String(req.originalUrl || req.url || "").slice(0, 400);
      const tenantId = resolveTenant(req);
      const email = resolveEmail(req);
      const { code, message } = extractErrorInfo(res.locals._errLogBody);
      setImmediate(async () => {
        try {
          const pool = await getServicesPool();
          await pool.request()
            .input("tenantId", sql.UniqueIdentifier, tenantId)
            .input("email", sql.NVarChar(256), email ? String(email).slice(0, 256) : null)
            .input("api", sql.NVarChar(20), api)
            .input("method", sql.NVarChar(10), method)
            .input("path", sql.NVarChar(400), path)
            .input("status", sql.Int, status)
            .input("code", sql.NVarChar(100), code)
            .input("message", sql.NVarChar(2000), message)
            .input("requestId", sql.NVarChar(64), requestId)
            .query(`
              INSERT INTO core.error_log (tenant_id, user_email, api, method, path, status, error_code, message, request_id)
              VALUES (@tenantId, @email, @api, @method, @path, @status, @code, @message, @requestId)
            `);
        } catch (e) {
          // The observer must never be the thing that makes noise fatal.
          console.error("[error-log] write failed:", e.message);
        }
      });
    });

    next();
  };
}
