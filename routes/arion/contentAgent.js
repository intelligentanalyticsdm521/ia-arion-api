// routes/arion/contentAgent.js
//
// Task 6 — the review queue. Scope Section 21.
//
// Mounted under /arion, which already carries requireAuth -> tenantResolution
// -> requireArionAccess -> arionRouteFeatures. So req.tenant.tenantId is the
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
import { loadActiveProfile } from '../../lib/contentAgent/styleProfile.js';
import { approveOutput, rejectOutput, DecisionRefused } from '../../lib/contentAgent/decisions.js';
import { handoffSocial } from '../../lib/contentAgent/socialHandoff.js';
import { businessTimeZone, nextDayAt } from '../../lib/businessTimeZone.js';
import { briefFor } from '../../lib/teamSeam.js';
import { checkContext, serviceNames } from '../../lib/jobChecks.js';
import { personName } from './reviewReplies.js';
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
// Body: { body_markdown?, title?, meta_description?, note?, scheduled_for? }
// Supplying edited text marks this 'edited' rather than 'approved'; the edited
// text is what will publish (AC3) and the delta becomes a style signal.
//
// ARGUS employees phase 1 (§G.3): the decision is written by
// lib/contentAgent/decisions.js approveOutput, the same writer the Automatic
// path uses. Its UPDATE is guarded on the status it read (finding F2). An
// ESCALATED draft is approved only with edits that pass every check again; a
// social post needs `scheduled_for` and is handed to the social scheduler
// right after the approval (lib/contentAgent/socialHandoff.js).
router.post('/queue/:id/approve', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', "That draft isn't waiting for you any more.");

  const edits = {
    body_markdown: req.body?.body_markdown ?? null,
    title: req.body?.title ?? null,
    meta_description: req.body?.meta_description ?? null,
  };
  const note = req.body?.note ?? null;
  const actor = personName(req);

  try {
    const pool = await getServicesPool();

    // A social post is approved WITH a time, or not at all.
    const kind = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('id', sql.UniqueIdentifier, id)
      .query('SELECT content_type FROM arion.content_agent_output WHERE tenant_id = @tenantId AND output_id = @id');
    const contentType = kind.recordset[0]?.content_type || null;
    const isSocial = contentType === 'social_post' || contentType === 'social_carousel';
    const when = req.body?.scheduled_for ? new Date(req.body.scheduled_for) : null;
    if (isSocial && (!when || Number.isNaN(when.getTime()))) {
      return fail(res, 400, 'SCHEDULE_REQUIRED', 'Pick when it should go out.');
    }

    let decided;
    try {
      decided = await approveOutput(pool, {
        tenantId, outputId: id, edits, note, actor,
        loadCheckCtx: async () => {
          const read = await briefFor(tenantId);
          return read && read.ok === true && read.brief
            ? checkContext(read.brief, { shippedFeatures: serviceNames(read.brief) })
            : null;
        },
      });
    } catch (err) {
      if (err instanceof DecisionRefused) return fail(res, err.status, err.code, err.message);
      throw err;
    }

    let handoff = null;
    if (isSocial) {
      handoff = await handoffSocial(pool, { tenantId, outputId: id, scheduledFor: when.toISOString(), approvedBy: actor });
    }

    res.json({
      data: {
        output_id: id,
        review_status: decided.review_status,
        // AC8, stated in the response so a caller cannot assume publication.
        published: false,
        ...(isSocial
          ? { scheduled: !!handoff?.ok, scheduled_social_post_id: handoff?.post_id || null, words: handoff?.words || null }
          : { words: 'Approved. It goes on your website when you press "Put it on your website".' }),
      },
    });
  } catch (err) {
    console.error('[contentAgent:approve]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /arion/content-agent/queue/:id/schedule — "Try again" for a social post
// whose hand-off to the scheduler failed. Idempotent on the scheduled post id.
// Body: { scheduled_for? } — default tomorrow 10:00 on the business's clock.
// ---------------------------------------------------------------------------
router.post('/queue/:id/schedule', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', "That post isn't waiting for you any more.");
  try {
    const pool = await getServicesPool();
    let when = req.body?.scheduled_for ? new Date(req.body.scheduled_for) : null;
    if (when && Number.isNaN(when.getTime())) return fail(res, 400, 'BAD_REQUEST', 'Pick when it should go out.');
    if (!when) when = new Date(nextDayAt(await businessTimeZone(pool, tenantId), '10:00'));
    const out = await handoffSocial(pool, { tenantId, outputId: id, scheduledFor: when.toISOString(), approvedBy: personName(req) });
    if (!out.ok) return fail(res, 502, 'HANDOFF_FAILED', out.words);
    res.json({ data: { output_id: id, scheduled_social_post_id: out.post_id, status: out.status || null, words: out.words } });
  } catch (err) {
    console.error('[contentAgent:schedule]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /arion/content-agent/queue/:id/reject   Body: { reason? }
// ---------------------------------------------------------------------------
// "Skip" on the Needs-you card. The reason is optional now (§F.1: "Why?
// (optional — it helps your team learn)"); the rejection is a learning signal
// either way.
router.post('/queue/:id/reject', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { id } = req.params;
  if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', "That draft isn't waiting for you any more.");
  try {
    const pool = await getServicesPool();
    try {
      const out = await rejectOutput(pool, { tenantId, outputId: id, reason: req.body?.reason ?? null, actor: personName(req) });
      res.json({ data: out });
    } catch (err) {
      if (err instanceof DecisionRefused) return fail(res, err.status, err.code, err.message);
      throw err;
    }
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
