// routes/arion/siteAudits.js
//
// The owner's view of the website checks their registered tool has run
// (contract §E.8). Mounted at /arion/audit inside routes/arion.js, so it sits
// behind requireAuth -> tenantResolution -> requireArionAccess, and
// req.tenant.tenantId is the RESOLVED business.
//
//   GET /arion/audit/runs?limit=50
//   GET /arion/audit/runs/:runId
//   GET /arion/audit/runs/:runId/file     the PDF itself, for the signed-in owner
//
// SCOPE: a run is visible only when its caller's owner_tenant_id is this
// business — joined in SQL (lib/audit/runs.js), never taken from the request.
//
// DECIDED (differs from contract §E.8): the owner's GET does NOT mint a new
// owner key. Replacing owner_key_hash would break the lasting link the lead
// already keeps ("the lead keeps the file"). The owner re-gets the file
// through the authenticated /file route instead, which needs no key at all.

import { Router } from 'express';
import { getServicesPool } from '../../db/servicesPool.js';
import { createSqlRepo } from '../../lib/audit/runs.js';
import { openPdf as realOpenPdf } from '../../lib/audit/store.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message, status } });

function shape(row) {
  return {
    run_id: row.run_id,
    url: row.url,
    status: row.status,
    score: row.score,
    summary_plain: row.summary_plain,
    error_plain: row.error_plain,
    created_at: row.created_at,
    finished_at: row.finished_at,
    has_file: Boolean(row.blob_path),
    file_path: row.blob_path ? `/arion/audit/runs/${String(row.run_id).toLowerCase()}/file` : null,
  };
}

export function createSiteAuditsRouter({ repo, openPdf = realOpenPdf, log = console }) {
  const router = Router({ mergeParams: true });

  router.get('/runs', async (req, res) => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return fail(res, 403, 'no_business', 'Choose a business first, then try again.');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
      const rows = await repo.listForOwner(tenantId, limit);
      res.json({ data: rows.map(shape) });
    } catch (err) {
      log.error?.(`[audit] owner list failed: ${err.message}`);
      fail(res, 500, 'audit_list_failed', "We couldn't load your website checks. Please try again in a minute.");
    }
  });

  router.get('/runs/:runId', async (req, res) => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return fail(res, 403, 'no_business', 'Choose a business first, then try again.');
    if (!GUID_RE.test(req.params.runId)) return fail(res, 404, 'not_found', "We couldn't find that website check.");
    try {
      const row = await repo.getForOwner(tenantId, req.params.runId);
      if (!row) return fail(res, 404, 'not_found', "We couldn't find that website check.");
      res.json({ data: shape(row) });
    } catch (err) {
      log.error?.(`[audit] owner read failed: ${err.message}`);
      fail(res, 500, 'audit_read_failed', "We couldn't load that website check. Please try again in a minute.");
    }
  });

  router.get('/runs/:runId/file', async (req, res) => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return fail(res, 403, 'no_business', 'Choose a business first, then try again.');
    if (!GUID_RE.test(req.params.runId)) return fail(res, 404, 'not_found', "We couldn't find that report.");
    try {
      const row = await repo.getForOwner(tenantId, req.params.runId);
      if (!row || !row.blob_path) return fail(res, 404, 'not_found', "We couldn't find that report.");
      const stream = await openPdf(row.blob_path);
      res.status(200).set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="website-audit.pdf"',
        'Cache-Control': 'private, max-age=0',
      });
      stream.on('error', (err) => { log.error?.(`[audit] owner file stream failed: ${err.message}`); res.destroy(err); });
      stream.pipe(res);
    } catch (err) {
      log.error?.(`[audit] owner file failed: ${err.message}`);
      fail(res, 500, 'audit_file_failed', "We couldn't open that report. Please try again in a few minutes.");
    }
  });

  return router;
}

export default createSiteAuditsRouter({ repo: createSqlRepo(getServicesPool) });
