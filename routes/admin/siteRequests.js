// routes/admin/siteRequests.js — founder queue for ARION change requests
// (Foundation §3A3). Mounted at /admin beside onboardExisting.js.
//
// AUTH: middleware/requireFounder.js — the static FOUNDER_ADMIN_TOKEN bearer
// (scripts, curl, server-to-server) OR a Portal sign-in holding an active
// founder / super_admin platform role. The token-only gate this shipped with
// was unusable from a browser, so the Portal page had no way in; the role path
// is the same question platform-api's isFounderCaller asks.
//
//   GET   /admin/site-requests?status=open|in_progress|done|declined
//   PATCH /admin/site-requests/:id  { status, resolutionNotes? }
//
// On a real move to done / declined the client is emailed the
// arion.site_request_resolved template (LUMEN migration 141) — see
// lib/siteRequests.js. Re-saving the status a request already has sends
// nothing.
import { Router } from "express";
import sql from "mssql";
import { getServicesPool } from "../../db/servicesPool.js";
import { getPlatformPool } from "../../db/platformPool.js";
import { requireFounder } from "../../middleware/requireFounder.js";
import { resolveAgencyTenantId } from "../../lib/agency.js";
import {
  listSiteRequestsForFounder,
  updateSiteRequestStatus,
  sendSiteRequestResolvedEmail,
  RESOLVED_STATUSES,
} from "../../lib/siteRequests.js";

const router = Router();

router.get("/site-requests", requireFounder, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  try {
    const pool = await getServicesPool();
    const requests = await listSiteRequestsForFounder(pool, { status });

    // Business names live in iadm_platform (core.tenants) — one IN query.
    const ids = [...new Set(requests.map((r) => String(r.tenantId).toLowerCase()))];
    if (ids.length) {
      const platform = await getPlatformPool();
      const q = platform.request();
      const params = ids.map((id, i) => { q.input(`t${i}`, sql.UniqueIdentifier, id); return `@t${i}`; });
      const tenants = await q.query(`SELECT tenant_id, name, full_name FROM core.tenants WHERE tenant_id IN (${params.join(",")})`);
      const byId = new Map(tenants.recordset.map((t) => [String(t.tenant_id).toLowerCase(), t]));
      for (const r of requests) {
        const t = byId.get(String(r.tenantId).toLowerCase());
        r.tenantName = t?.full_name || t?.name || null;
      }
    }
    res.json({ requests });
  } catch (err) {
    if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message, status: 400 } });
    console.error("[admin/site-requests]", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message, status: 500 } });
  }
});

/**
 * Everything the resolved email needs that the request row does not carry:
 * the site's domain, the agency that serves this business (LUMEN picks the
 * from-address from it) and the asker's first name. Best-effort — each piece
 * degrades to a sensible default rather than blocking the send.
 */
export async function collectResolvedEmailInputs(servicesPool, platformPool, request) {
  const out = { site: null, senderTenantId: null, senderName: null, recipientFirstName: null };
  try {
    const s = await servicesPool.request()
      .input("siteId", sql.UniqueIdentifier, request.siteId)
      .query("SELECT TOP 1 domain FROM arion.site WHERE site_id = @siteId");
    out.site = s.recordset[0] || null;
  } catch (err) { console.warn("[admin/site-requests] domain lookup:", err.message); }

  try {
    out.senderTenantId = await resolveAgencyTenantId(request.tenantId);
    const t = await platformPool.request()
      .input("tid", sql.UniqueIdentifier, out.senderTenantId)
      .query("SELECT TOP 1 name, full_name FROM core.tenants WHERE tenant_id = @tid");
    out.senderName = t.recordset[0]?.full_name || t.recordset[0]?.name || null;
  } catch (err) { console.warn("[admin/site-requests] agency lookup:", err.message); }

  if (request.requestedByEmail) {
    try {
      const u = await platformPool.request()
        .input("email", sql.NVarChar(320), request.requestedByEmail)
        .query("SELECT TOP 1 first_name FROM core.users WHERE LOWER(email) = LOWER(@email)");
      out.recipientFirstName = u.recordset[0]?.first_name || null;
    } catch (err) { console.warn("[admin/site-requests] recipient lookup:", err.message); }
  }
  return out;
}

router.patch("/site-requests/:id", requireFounder, async (req, res) => {
  const { status, resolutionNotes } = req.body || {};
  if (!status) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "status is required", status: 400 } });
  try {
    const pool = await getServicesPool();
    const request = await updateSiteRequestStatus(pool, { siteRequestId: req.params.id, status, resolutionNotes });
    if (!request) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Site request not found", status: 404 } });

    // Email the client ONLY when the status actually moved into done /
    // declined. Re-saving "done" to correct a typo in the note must not send a
    // second "your request is done" email.
    const movedToResolved = RESOLVED_STATUSES.includes(request.status)
      && request.previousStatus !== request.status;
    if (movedToResolved) {
      // Fire-and-forget: the move is saved whether or not the email goes.
      (async () => {
        const platform = await getPlatformPool();
        const inputs = await collectResolvedEmailInputs(pool, platform, request);
        return sendSiteRequestResolvedEmail({ request, ...inputs });
      })().catch((e) => console.error("[admin/site-requests] resolved email:", e.message));
    }

    res.json({ request, clientEmailQueued: movedToResolved });
  } catch (err) {
    if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message, status: 400 } });
    console.error("[admin/site-requests PATCH]", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message, status: 500 } });
  }
});

export default router;
