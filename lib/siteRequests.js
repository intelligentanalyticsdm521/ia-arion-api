// lib/siteRequests.js — ARION "request a change" (Foundation §3A3).
//
// One table, arion.site_request (migration 055). The client route in
// routes/arion.js creates + lists a site's own requests; the founder queue in
// routes/admin/siteRequests.js lists across tenants and moves status. All the
// SQL lives here so both routes and the tests share one implementation.
//
// Status vocabulary (CHECK constraint in 055): open → in_progress → done |
// declined. done / declined stamp resolved_at; moving back clears it.
import sql from "mssql";
import crypto from "node:crypto";
import { sendEmail } from "./email.js";

export const SITE_REQUEST_STATUSES = Object.freeze(["open", "in_progress", "done", "declined"]);
export const RESOLVED_STATUSES = Object.freeze(["done", "declined"]);
const CLIENT_LIST_LIMIT = 50;
const FOUNDER_LIST_LIMIT = 200;

/** DB row → API shape (camelCase, same idiom as toSiteSummary). */
export function toApi(row) {
  if (!row) return null;
  return {
    siteRequestId: row.site_request_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    requestType: row.request_type,
    notes: row.notes,
    status: row.status,
    requestedByEmail: row.requested_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolutionNotes: row.resolution_notes,
    ...(row.domain !== undefined ? { domain: row.domain } : {}),
    // Only the founder UPDATE outputs DELETED.status; the lists never carry it.
    ...(row.previous_status !== undefined ? { previousStatus: row.previous_status } : {}),
  };
}

export async function createSiteRequest(pool, { tenantId, siteId, requestType, notes, requestedByEmail }) {
  if (!requestType) throw Object.assign(new Error("requestType is required"), { code: "VALIDATION_ERROR" });
  const siteRequestId = crypto.randomUUID();
  const r = await pool.request()
    .input("id", sql.UniqueIdentifier, siteRequestId)
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("requestType", sql.NVarChar(40), String(requestType).slice(0, 40))
    .input("notes", sql.NVarChar(sql.MAX), notes == null ? null : String(notes))
    .input("requestedBy", sql.NVarChar(320), requestedByEmail ? String(requestedByEmail).slice(0, 320) : null)
    .query(`
      INSERT INTO arion.site_request
        (site_request_id, tenant_id, site_id, request_type, notes, status, requested_by_email)
      OUTPUT INSERTED.*
      VALUES (@id, @tenantId, @siteId, @requestType, @notes, 'open', @requestedBy)
    `);
  return toApi(r.recordset[0]);
}

/** The tenant's own history for one site — newest first. */
export async function listSiteRequests(pool, { tenantId, siteId, limit = CLIENT_LIST_LIMIT }) {
  const r = await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("top", sql.Int, Math.min(CLIENT_LIST_LIMIT, Math.max(1, Number(limit) || CLIENT_LIST_LIMIT)))
    .query(`
      SELECT TOP (@top) *
        FROM arion.site_request
       WHERE tenant_id = @tenantId AND site_id = @siteId
       ORDER BY created_at DESC
    `);
  return r.recordset.map(toApi);
}

/** Founder queue — every tenant, optional status filter, site domain joined. */
export async function listSiteRequestsForFounder(pool, { status = null, limit = FOUNDER_LIST_LIMIT } = {}) {
  if (status && !SITE_REQUEST_STATUSES.includes(status)) {
    throw Object.assign(new Error(`status must be one of ${SITE_REQUEST_STATUSES.join(", ")}`), { code: "VALIDATION_ERROR" });
  }
  const r = await pool.request()
    .input("status", sql.NVarChar(20), status || null)
    .input("top", sql.Int, Math.min(FOUNDER_LIST_LIMIT, Math.max(1, Number(limit) || FOUNDER_LIST_LIMIT)))
    .query(`
      SELECT TOP (@top) r.*, s.domain
        FROM arion.site_request r
        LEFT JOIN arion.site s ON s.site_id = r.site_id AND s.tenant_id = r.tenant_id
       WHERE (@status IS NULL OR r.status = @status)
       ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, r.created_at DESC
    `);
  return r.recordset.map(toApi);
}

/**
 * Founder moves a request. Returns the updated row (with `previousStatus` so
 * the caller can tell a real move from a re-save of the same status), or null
 * when not found.
 */
export async function updateSiteRequestStatus(pool, { siteRequestId, status, resolutionNotes }) {
  if (!SITE_REQUEST_STATUSES.includes(status)) {
    throw Object.assign(new Error(`status must be one of ${SITE_REQUEST_STATUSES.join(", ")}`), { code: "VALIDATION_ERROR" });
  }
  const resolved = RESOLVED_STATUSES.includes(status) ? 1 : 0;
  const r = await pool.request()
    .input("id", sql.UniqueIdentifier, siteRequestId)
    .input("status", sql.NVarChar(20), status)
    .input("resolved", sql.Bit, resolved)
    .input("notes", sql.NVarChar(2000), resolutionNotes == null ? null : String(resolutionNotes).slice(0, 2000))
    .query(`
      UPDATE arion.site_request
         SET status = @status,
             resolution_notes = COALESCE(@notes, resolution_notes),
             resolved_at = CASE WHEN @resolved = 1 THEN SYSUTCDATETIME() ELSE NULL END,
             updated_at = SYSUTCDATETIME()
      OUTPUT DELETED.status AS previous_status, INSERTED.*
       WHERE site_request_id = @id
    `);
  return r.recordset.length ? toApi(r.recordset[0]) : null;
}

/**
 * Tell the founder inbox a request landed. Fire-and-forget by contract: never
 * throws, never blocks the client response. Skips (and says so) when
 * SITE_REQUEST_NOTIFY_EMAIL is unset — a missing address is a config gap to
 * surface in the log, not a silent success.
 */
export async function notifyFounderOfSiteRequest({ request, site, tenant }, send = sendEmail) {
  const to = process.env.SITE_REQUEST_NOTIFY_EMAIL;
  if (!to) {
    console.warn("[siteRequests] SITE_REQUEST_NOTIFY_EMAIL not set — founder not emailed for", request?.siteRequestId);
    return { ok: false, error: "not_configured" };
  }
  const tenantName = tenant?.tenantFullName || tenant?.tenantName || request?.tenantId || "client";
  const domain = site?.domain || request?.siteId || "site";
  const subject = `Change request — ${tenantName} / ${domain}`;
  const notes = String(request?.notes || "").trim() || "(no details given)";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<p><strong>${esc(tenantName)}</strong> asked for a change on <strong>${esc(domain)}</strong>.</p>`
    + `<p>Type: ${esc(request?.requestType || "")}<br/>From: ${esc(request?.requestedByEmail || "unknown")}</p>`
    + `<pre style="white-space:pre-wrap;font-family:inherit">${esc(notes)}</pre>`
    + `<p>Request id: ${esc(request?.siteRequestId || "")}</p>`;
  try {
    return await send({
      to, subject, html,
      text: `${tenantName} asked for a change on ${domain}.\nType: ${request?.requestType || ""}\nFrom: ${request?.requestedByEmail || "unknown"}\n\n${notes}\n\nRequest id: ${request?.siteRequestId || ""}`,
      tag: "site-request",
      metadata: { tenant_id: String(request?.tenantId || ""), site_id: String(request?.siteId || ""), site_request_id: String(request?.siteRequestId || "") },
    });
  } catch (err) {
    console.error("[siteRequests] founder email failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── telling the client it is done ────────────────────────────────────────
//
// LUMEN migration 141 seeded the system template but nothing sent it, so a
// client who asked for a change never heard back. The send goes through
// LUMEN's internal send-by-template-key — the same door lib/welcomeEmail.js
// uses — because that is where email templates, senders and the campaign
// record live. arion-api has no generic LUMEN client (welcomeEmail.js's sender
// is welded to the onboarding context), so this is the smallest one that does
// the job; if a third caller appears, lift these two helpers out.

/** The template LUMEN migration 141 seeded on tenant_id='iadm-platform'. */
export const RESOLVED_TEMPLATE_KEY = "arion.site_request_resolved";
const RESOLVED_EMAIL_TIMEOUT_MS = 8000;

function getLumenBase() {
  return (process.env.LUMEN_API_BASE_URL || process.env.SPARK_API_BASE_URL || "").replace(/\/+$/, "");
}

function getLumenInternalToken() {
  return process.env.LUMEN_EMAIL_INTERNAL_TOKEN
    || process.env.LUMEN_INTERNAL_SERVICE_TOKEN
    || process.env.LUMEN_WALKTHROUGH_SEED_TOKEN
    || process.env.WALKTHROUGH_SEED_INTERNAL_TOKEN
    || "";
}

/** First line of the request, for the "Request: …" line in the template. */
export function summarizeRequest(request) {
  const raw = String(request?.notes || "").replace(/\s+/g, " ").trim();
  if (!raw) return request?.requestType ? String(request.requestType).replace(/_/g, " ") : "your change request";
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

/**
 * Tell the client their request was finished or declined.
 *
 * Never throws — the status change is already saved and must stand whatever
 * email does. Returns { ok, error? } and logs the reason on every skip, so a
 * missing setting shows up in the log instead of reading as a send.
 *
 * @param senderTenantId the AGENCY tenant (resolveAgencyTenantId) — LUMEN
 *        picks the from-address from it, same as the welcome emails.
 */
export async function sendSiteRequestResolvedEmail(
  { request, site, senderTenantId, senderName, recipientFirstName },
  fetchImpl = fetch,
) {
  const to = request?.requestedByEmail;
  if (!to) {
    console.warn("[siteRequests] no requested_by_email on", request?.siteRequestId, "— client not emailed");
    return { ok: false, error: "missing_recipient_email" };
  }
  if (!RESOLVED_STATUSES.includes(request?.status)) {
    return { ok: false, error: "status_not_resolved" };
  }
  const base = getLumenBase();
  const token = getLumenInternalToken();
  if (!base || !token) {
    console.warn("[siteRequests] LUMEN base URL / internal token not set — client not emailed for", request?.siteRequestId);
    return { ok: false, error: "not_configured" };
  }

  const body = JSON.stringify({
    tenantId: senderTenantId,
    templateKey: RESOLVED_TEMPLATE_KEY,
    recipientEmail: to,
    context: {
      contact: { first_name: (recipientFirstName || "").trim() || "there", email: to },
      site: { domain: site?.domain || "your website" },
      request: {
        status: request.status === "done" ? "done" : "declined",
        resolution_notes: request.resolutionNotes || "",
        summary: summarizeRequest(request),
      },
      tenant: { name: senderName || "Intelligent Analytics" },
    },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVED_EMAIL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/api/v1/internal/email/send-by-template-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-internal-token": token,
        "x-tenant-id": String(senderTenantId || ""),
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`[siteRequests] resolved email ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, error: text.slice(0, 300) || `lumen_http_${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : (err?.message || "fetch_error");
    console.error("[siteRequests] resolved email failed:", reason);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
