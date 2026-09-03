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

/** Founder moves a request. Returns the updated row, or null when not found. */
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
      OUTPUT INSERTED.*
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
