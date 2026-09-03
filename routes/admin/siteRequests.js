// routes/admin/siteRequests.js — founder queue for ARION change requests
// (Foundation §3A3). Mounted at /admin beside onboardExisting.js and gated by
// the same static FOUNDER_ADMIN_TOKEN bearer.
//
// PLACEMENT NOTE: the scope puts this queue in platform-api behind the
// Portal-usable isFounderCaller gate (core.user_platform_roles). platform-api
// had no worktree in this build, so the queue lives here behind arion-api's
// existing env-token founder gate. Moving it is a lift-and-shift of the two
// handlers below onto lib/siteRequests.js's functions; the Portal admin page
// (Portal step 10) should target platform-api when that lands.
//
//   GET   /admin/site-requests?status=open|in_progress|done|declined
//   PATCH /admin/site-requests/:id  { status, resolutionNotes? }
//
// Not built here (needs LUMEN internal send + template arion.site_request_resolved
// seeded by LUMEN migration 141): emailing the client on done / declined.
import { Router } from "express";
import sql from "mssql";
import { getServicesPool } from "../../db/servicesPool.js";
import { getPlatformPool } from "../../db/platformPool.js";
import { requireFounderAuth } from "./onboardExisting.js";
import { listSiteRequestsForFounder, updateSiteRequestStatus } from "../../lib/siteRequests.js";

const router = Router();

router.get("/site-requests", requireFounderAuth, async (req, res) => {
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

router.patch("/site-requests/:id", requireFounderAuth, async (req, res) => {
  const { status, resolutionNotes } = req.body || {};
  if (!status) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "status is required", status: 400 } });
  try {
    const pool = await getServicesPool();
    const request = await updateSiteRequestStatus(pool, { siteRequestId: req.params.id, status, resolutionNotes });
    if (!request) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Site request not found", status: 404 } });
    res.json({ request });
  } catch (err) {
    if (err.code === "VALIDATION_ERROR") return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message, status: 400 } });
    console.error("[admin/site-requests PATCH]", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message, status: 500 } });
  }
});

export default router;
