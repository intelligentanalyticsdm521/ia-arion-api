// routes/arion/contentAgent.js
//
// Task 6 — the review queue. Scope Section 21.
//
// Mounted under /arion, which already carries requireAuth -> tenantResolution
// -> requireArionAccess -> requireArionTier. So req.tenant.tenantId is the
// RESOLVED active tenant.
//
// TENANT SCOPING RULE FOR THIS FILE: every statement takes its tenant from
// req.tenant.tenantId and never from a route param, query string or body. The
// documented wrong-tenant root cause on this platform is trusting a
// caller-supplied tenant (or the JWT `tid`) instead of the resolved active
// tenant, and a content agent that writes to the wrong tenant publishes one
// client's voice on another client's site.
//
// AC2 — escalated units are withheld from the normal queue. They are returned
// in a SEPARATE `escalated` collection so they are visible but can never be
// mistaken for ready-to-publish. A caller that renders `data` and ignores the
// rest shows only approvable work, which is the safe default.
//
// AC3 — the approved (possibly EDITED) version is what publishes. The edit is
// written to body_markdown_final, leaving body_markdown as the agent's original
// for comparison (E2) and, more importantly, as the raw material for style
// learning: the diff between what the agent wrote and what shipped is the
// highest-signal input the whole system has.
//
// AC8 — approval is an explicit action. Nothing here schedules to WordPress as
// a side effect of anything else.

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { recordSignal, SIGNAL_KIND, loadActiveProfile } from '../../lib/contentAgent/styleProfile.js';
import { checkCycleBudget } from '../../lib/contentAgent/costBreaker.js';
import { publishApproved, PublishRefused } from '../../lib/contentAgent/publisher.js';
import { notifyTenantAlerts } from '../../lib/contentAgent/alerts.js';

const router = Router({ mergeParams: true });

const fail = (res, status, code, message) =>
  res.status(status).json({ error: { code, message, status } });

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /arion/content-agent/queue
// ---------------------------------------------------------------------------
router.get('/queue', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 25));
  const offset = (page - 1) * perPage;

  try {
    const pool = await getServicesPool();

    const cols = `output_id, run_id, content_type, primary_keyword, keyword_volume,
                  keyword_kd, keyword_intent, keyword_rationale, title, body_markdown,
                  meta_description, url_slug, cover_image_prompt, asset_uri,
                  style_profile_id, decision_rule_flags_json, confidence_note,
                  review_status, created_at`;

    const [pending, escalated, countRes] = await Promise.all([
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('offset', sql.Int, offset)
        .input('perPage', sql.Int, perPage)
        .query(`
          SELECT ${cols}
            FROM arion.content_agent_output
           WHERE tenant_id = @tenantId AND review_status = 'pending'
           ORDER BY created_at DESC
           OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY`),
      // AC2 — kept apart from the approvable queue on purpose.
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT ${cols}
            FROM arion.content_agent_output
           WHERE tenant_id = @tenantId AND review_status = 'escalated'
           ORDER BY created_at DESC`),
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(*) AS total
            FROM arion.content_agent_output
           WHERE tenant_id = @tenantId AND review_status = 'pending'`),
    ]);

    const parseFlags = (r) => ({
      ...r,
      decision_rule_flags: (() => {
        try { return JSON.parse(r.decision_rule_flags_json || '[]'); } catch { return []; }
      })(),
    });

    res.json({
      data: pending.recordset.map(parseFlags),
      escalated: escalated.recordset.map(parseFlags),
      meta: {
        total: countRes.recordset[0].total,
        escalated_count: escalated.recordset.length,
        page,
        per_page: perPage,
      },
    });
  } catch (err) {
    console.error('[contentAgent:queue]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /arion/content-agent/queue/:id/approve
// ---------------------------------------------------------------------------
// Body: { body_markdown?, title?, meta_description?, note? }
// Supplying edited text marks this 'edited' rather than 'approved'; the edited
// text is what will publish (AC3) and the delta becomes a style signal.
router.post('/queue/:id/approve', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', 'output_id must be a GUID');

  const reviewer = req.user?.email || req.user?.oid || null;
  const edited = {
    body_markdown: req.body?.body_markdown ?? null,
    title: req.body?.title ?? null,
    meta_description: req.body?.meta_description ?? null,
  };
  const note = req.body?.note ?? null;

  try {
    const pool = await getServicesPool();

    // Read the current row, tenant-scoped. This both authorises the action and
    // gives us the ORIGINAL text to diff against.
    const cur = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('id', sql.UniqueIdentifier, id)
      .query(`
        SELECT output_id, title, body_markdown, meta_description, review_status
          FROM arion.content_agent_output
         WHERE tenant_id = @tenantId AND output_id = @id`);

    const row = cur.recordset[0];
    // A row belonging to another tenant is indistinguishable from one that does
    // not exist. That is deliberate — it leaks nothing.
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such queue item for this tenant');

    if (row.review_status === 'escalated') {
      // AC2: an escalated unit must be cleared deliberately, not approved
      // through the ordinary path where its flags might go unread.
      return fail(res, 409, 'ESCALATED',
        'This unit tripped an escalation rule and cannot be approved from the normal queue. Review its flags and clear it explicitly.');
    }
    if (row.review_status !== 'pending') {
      return fail(res, 409, 'ALREADY_REVIEWED', `Already ${row.review_status}`);
    }

    const changed = (a, b) => b != null && String(a || '').trim() !== String(b).trim();
    const bodyChanged = changed(row.body_markdown, edited.body_markdown);
    const titleChanged = changed(row.title, edited.title);
    const metaChanged = changed(row.meta_description, edited.meta_description);
    const wasEdited = bodyChanged || titleChanged || metaChanged;

    // AC3 — the FINAL column is what the publisher reads. Fall back to the
    // original when nothing was edited so the publisher has one field to trust.
    const finalBody = edited.body_markdown ?? row.body_markdown;

    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('id', sql.UniqueIdentifier, id)
      .input('finalBody', sql.NVarChar(sql.MAX), finalBody)
      .input('title', sql.NVarChar(500), edited.title ?? row.title)
      .input('meta', sql.NVarChar(500), edited.meta_description ?? row.meta_description)
      .input('status', sql.NVarChar(20), wasEdited ? 'edited' : 'approved')
      .input('note', sql.NVarChar(sql.MAX), note)
      .input('by', sql.NVarChar(256), reviewer)
      .query(`
        UPDATE arion.content_agent_output
           SET body_markdown_final = @finalBody,
               title = @title,
               meta_description = @meta,
               review_status = @status,
               review_note = @note,
               reviewed_by = @by,
               approved_at = SYSDATETIMEOFFSET()
         WHERE tenant_id = @tenantId AND output_id = @id`);

    // --- the learning loop ---------------------------------------------------
    // Every review outcome is evidence. An edit teaches the most, so it is
    // recorded per changed field rather than as one lump.
    if (wasEdited) {
      const fields = [
        ['body', row.body_markdown, edited.body_markdown, bodyChanged],
        ['title', row.title, edited.title, titleChanged],
        ['meta_description', row.meta_description, edited.meta_description, metaChanged],
      ];
      for (const [name, before, after, didChange] of fields) {
        if (!didChange) continue;
        await recordSignal(pool, {
          tenantId,
          outputId: id,
          signalKind: SIGNAL_KIND.EDITED,
          fieldName: name,
          beforeText: before,
          afterText: after,
          reviewerNote: note,
        });
      }
    } else {
      await recordSignal(pool, {
        tenantId, outputId: id, signalKind: SIGNAL_KIND.APPROVED_AS_IS, reviewerNote: note,
      });
    }

    res.json({
      data: {
        output_id: id,
        review_status: wasEdited ? 'edited' : 'approved',
        // AC8, stated in the response so a caller cannot assume publication.
        published: false,
        note: 'Approved. Scheduling to WordPress is a separate step and has not happened yet — POST .../publish when you want it scheduled.',
      },
    });
  } catch (err) {
    console.error('[contentAgent:approve]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /arion/content-agent/queue/:id/reject
// ---------------------------------------------------------------------------
router.post('/queue/:id/reject', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', 'output_id must be a GUID');

  const reason = String(req.body?.reason || '').trim();
  // A rejection with no reason teaches the style loop nothing, which is most of
  // the point of rejecting.
  if (!reason) return fail(res, 400, 'REASON_REQUIRED', 'A rejection reason is required — it is what the agent learns from');

  try {
    const pool = await getServicesPool();
    const upd = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('id', sql.UniqueIdentifier, id)
      .input('reason', sql.NVarChar(sql.MAX), reason)
      .input('by', sql.NVarChar(256), req.user?.email || req.user?.oid || null)
      .query(`
        UPDATE arion.content_agent_output
           SET review_status = 'rejected', review_note = @reason,
               reviewed_by = @by, approved_at = NULL
         WHERE tenant_id = @tenantId AND output_id = @id
           AND review_status IN ('pending','escalated');
        SELECT @@ROWCOUNT AS affected;`);

    if (!upd.recordset[0].affected) {
      return fail(res, 404, 'NOT_FOUND', 'No such reviewable queue item for this tenant');
    }

    await recordSignal(pool, {
      tenantId, outputId: id, signalKind: SIGNAL_KIND.REJECTED, reviewerNote: reason,
    });

    res.json({ data: { output_id: id, review_status: 'rejected' } });
  } catch (err) {
    console.error('[contentAgent:reject]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /arion/content-agent/queue/:id/publish — AC8's second half
// ---------------------------------------------------------------------------
// THE APPROVAL AND THE PUBLISH ARE TWO SEPARATE HUMAN ACTIONS. Approving writes
// body_markdown_final and stops (see /approve, which says so in its response).
// This is the only door to WordPress, and lib/contentAgent/publisher.js refuses
// anything whose review_status is not approved/edited, refuses again on a
// missing approval timestamp, and re-asserts both in the UPDATE's WHERE clause.
//
// Task 7 shipped the publisher and nothing called it, so an approved unit could
// never actually be scheduled — the module was unreachable from the API. This
// route is that wiring and nothing more: the gate logic stays in the publisher
// where its tests are.
//
// F5: a plugin failure leaves the row approved-and-unscheduled and raises an
// alert through the ONE notification gate. It never reports success it did not
// have — the recurring catch-swallow-report-200 defect is precisely what a
// "published" flag on a failed publish would be.
router.post('/queue/:id/publish', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', 'output_id must be a GUID');

  const status = req.body?.status === 'publish' ? 'publish' : 'future';
  const publishAt = req.body?.publish_at || null;

  try {
    const pool = await getServicesPool();
    let result;
    try {
      result = await publishApproved({ pool, tenantId, outputId: id, status, publishAt });
    } catch (err) {
      if (!(err instanceof PublishRefused)) throw err;
      const code = err.code === 'not_found' ? 404 : 409;
      return fail(res, code, err.code.toUpperCase(), err.message);
    }

    if (!result.ok) {
      // Tell a human, through the gate, named by the one identity.
      const notified = await notifyTenantAlerts({
        tenantId, alerts: [result.alert],
        log: (m) => console.warn(`[contentAgent:publish] ${m}`),
      }).catch((e) => ({ outcome: 'send_failed', reason: e.message }));

      return res.status(502).json({
        error: {
          code: result.alert.code, message: result.alert.message, status: 502,
          failure_mode: result.alert.failure_mode,
        },
        data: { output_id: id, published: false, review_status_unchanged: true },
        meta: { alert: notified?.outcome || null },
      });
    }

    res.json({
      data: {
        output_id: id,
        published: true,
        wordpress_post_id: result.wordpressPostId,
        post_url: result.postUrl,
        site_id: result.siteId,
        scheduled_status: status,
      },
    });
  } catch (err) {
    console.error('[contentAgent:publish]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /arion/content-agent/runs — AC6, AC7
// ---------------------------------------------------------------------------
router.get('/runs', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 25));
  const offset = (page - 1) * perPage;
  const status = req.query.status ? String(req.query.status) : null;

  try {
    const pool = await getServicesPool();
    const [rows, totals] = await Promise.all([
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(20), status)
        .input('offset', sql.Int, offset)
        .input('perPage', sql.Int, perPage)
        .query(`
          SELECT run_id, agent_name, agent_version, trigger_source, status,
                 triggered_at, completed_at, tokens_in, tokens_out, cost_usd,
                 model_version, decision_rule_flags_json, error_detail
            FROM arion.content_agent_run_log
           WHERE tenant_id = @tenantId
             AND (@status IS NULL OR status = @status)
           ORDER BY triggered_at DESC
           OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY`),
      // AC7 is measured by aggregating this log, so the endpoint returns the
      // aggregate rather than making every caller recompute it.
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT COUNT(*) AS total,
                 COALESCE(SUM(cost_usd), 0) AS cost_usd_all_time,
                 COALESCE(SUM(CASE WHEN triggered_at >= DATEADD(DAY, -30, SYSDATETIMEOFFSET())
                                   THEN cost_usd ELSE 0 END), 0) AS cost_usd_30d,
                 SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) AS escalated
            FROM arion.content_agent_run_log
           WHERE tenant_id = @tenantId`),
    ]);

    const t = totals.recordset[0];
    const budget = await checkCycleBudget(pool, tenantId).catch(() => null);

    res.json({
      data: rows.recordset,
      meta: {
        total: t.total,
        page,
        per_page: perPage,
        cost_usd_all_time: Number(t.cost_usd_all_time),
        cost_usd_30d: Number(t.cost_usd_30d),
        failed: t.failed,
        escalated: t.escalated,
        cost_breaker: budget,
      },
    });
  } catch (err) {
    console.error('[contentAgent:runs]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /arion/content-agent/style — what the agent has learned about this tenant
// ---------------------------------------------------------------------------
// Not in the original Section 21 surface; added with the 12.12 capability so the
// learned profile is inspectable. A style profile that cannot be read is a
// style profile nobody can correct.
router.get('/style', async (req, res) => {
  try {
    const pool = await getServicesPool();
    const profile = await loadActiveProfile(pool, req.tenant.tenantId);
    if (!profile) {
      return res.json({ data: null, meta: { message: 'No style profile learned yet for this tenant.' } });
    }
    res.json({
      data: {
        version: profile.version,
        evidence_count: profile.evidenceCount,
        confidence: profile.confidence,
        formatting: profile.formatting,
        vocabulary_banned_count: (profile.vocabulary?.banned || []).length,
        exemplar_count: (profile.voice?.exemplars || []).length,
        learned_through: profile.learnedThrough,
      },
    });
  } catch (err) {
    console.error('[contentAgent:style]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// Code proposals — scope 12.13, PROPOSE-ONLY
// ---------------------------------------------------------------------------
// These endpoints READ proposals and record a human's verdict. There is
// deliberately no endpoint that applies one: applying a proposal means taking it
// through the ordinary session process — scope, plan, review, migration, deploy
// — exactly as if a person had written it. `applied_commit` is a record of what
// a human did afterwards, never an instruction the agent can act on.

router.get('/proposals', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const status = req.query.status ? String(req.query.status) : 'pending';
  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('status', sql.NVarChar(20), status)
      .query(`
        SELECT proposal_id, run_id, proposal_kind, target_repo, target_path,
               diff_text, rationale, risk_note, evidence_json, review_status,
               reviewed_by, reviewed_at, applied_commit, created_at
          FROM arion.content_agent_code_proposal
         WHERE tenant_id = @tenantId AND review_status = @status
         ORDER BY created_at DESC`);
    res.json({
      data: r.recordset,
      meta: {
        total: r.recordset.length,
        note: 'Proposals are advisory. Nothing here is applied automatically; a human takes an approved diff through the normal review and deploy process.',
      },
    });
  } catch (err) {
    console.error('[contentAgent:proposals]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/proposals/:id/:decision', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id, decision } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', 'proposal_id must be a GUID');
  if (!['approve', 'reject'].includes(decision)) {
    return fail(res, 400, 'BAD_REQUEST', 'decision must be approve or reject');
  }

  try {
    const pool = await getServicesPool();
    const upd = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('id', sql.UniqueIdentifier, id)
      .input('status', sql.NVarChar(20), decision === 'approve' ? 'approved' : 'rejected')
      .input('by', sql.NVarChar(256), req.user?.email || req.user?.oid || null)
      .query(`
        UPDATE arion.content_agent_code_proposal
           SET review_status = @status, reviewed_by = @by, reviewed_at = SYSDATETIMEOFFSET()
         WHERE tenant_id = @tenantId AND proposal_id = @id AND review_status = 'pending';
        SELECT @@ROWCOUNT AS affected;`);

    if (!upd.recordset[0].affected) return fail(res, 404, 'NOT_FOUND', 'No such pending proposal for this tenant');

    res.json({
      data: {
        proposal_id: id,
        review_status: decision === 'approve' ? 'approved' : 'rejected',
        applied: false,
        note: decision === 'approve'
          ? 'Marked approved. This does NOT apply the change — take the diff through the normal scope/plan/deploy process.'
          : 'Marked rejected.',
      },
    });
  } catch (err) {
    console.error('[contentAgent:proposal-decision]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

export default router;
