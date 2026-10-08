// routes/arion/reviewReplies.js — the owner's side of "Google review replies".
//
//   POST /arion/review-replies/:id/approve  { body? }   post this reply (or "Try again")
//   POST /arion/review-replies/:id/skip     { reason? } don't answer this one
//   POST /arion/review-replies/run                      "Run it now", this business only
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.2). Mounted at
// /arion/review-replies behind the same chain as /arion/agents (routes/arion.js):
// requireAuth -> tenantResolution -> requireArionAccess -> requireArionTier,
// and requireArionTenantAdmin for these writes.
//
// TENANT SCOPING: every statement takes its business from req.tenant.tenantId,
// never from a param, query or body.
//
// APPROVE RE-READS GOOGLE FIRST. A review somebody already answered on Google
// is stood down, not answered twice. When Google cannot be read, nothing is
// posted (503): posting blind is how a review gets two replies.
//
// AN EDITED REPLY IS CHECKED AGAIN, every check except "3 stars or fewer
// waits for you" (a person approving IS the asking). A check that fires
// refuses with its sentence and nothing is posted.
//
// THE STATUS MOVE IS GUARDED: `status IN ('held','failed')` and exactly one
// row, or 409.

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { reviewsApi } from '../../lib/gbpFake.js';
import { runReviewReplyTick, markReply, JOB_KEY } from '../../lib/gbpReplyRunner.js';
import { jobsOn as seamJobsOn, briefFor as seamBriefFor } from '../../lib/teamSeam.js';
import { runChecks, PLATFORM_CHECKS, checkContext } from '../../lib/jobChecks.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message, status } });

export const WORDS = Object.freeze({
  notWaiting: "That reply isn't waiting for you any more.",
  alreadyAnswered: "Someone already answered this review on Google, so I didn't post.",
  googleUnreadable: "I couldn't check Google just now, so I didn't post. Try again in a minute.",
  googleRefused: "Google didn't take this reply, so it's still waiting for you. Try again.",
  briefUnreadable: "I couldn't read your business details to check your changes, so I didn't post. Try again in a minute.",
  raced: 'That reply was decided somewhere else just now.',
  jobOff: 'Google review replies are off. Switch them on first.',
  jobUnreadable: "ARGUS couldn't check whether Google review replies are on, so nothing ran. Try again in a minute.",
  emptyBody: 'Write the reply first.',
});

/** Who decided, in a person's words. */
export function personName(req) {
  return req.auth?.name || req.auth?.email || req.auth?.preferred_username
    || (Array.isArray(req.auth?.emails) ? req.auth.emails[0] : null) || req.user?.email || null;
}

/** The checks an edited reply runs again: the job's, minus the low-star hold. */
export const EDIT_CHECKS = Object.freeze(PLATFORM_CHECKS[JOB_KEY].filter((c) => c !== 'low_star_review_asks'));

/**
 * Factory so tests can hand in a fake pool, a fake Google and fake readers.
 */
export function makeReviewRepliesRouter({
  getPool = getServicesPool,
  api = () => reviewsApi(),
  jobsOn = seamJobsOn,
  briefFor = seamBriefFor,
  tick = runReviewReplyTick,
} = {}) {
  const router = Router({ mergeParams: true });

  router.post('/run', async (req, res) => {
    const tenantId = req.tenant.tenantId;
    try {
      const state = await jobsOn([JOB_KEY], { tenantId });
      if (!state || state.ok !== true || !(state.on instanceof Map)) return fail(res, 503, 'JOB_STATE_UNREADABLE', WORDS.jobUnreadable);
      const mine = state.on.get(String(tenantId).toUpperCase());
      if (!(mine instanceof Map) || !mine.has(JOB_KEY)) return fail(res, 409, 'JOB_OFF', WORDS.jobOff);
      const pool = await getPool();
      const summary = await tick(pool, (m) => console.log(`[review-replies:run] ${m}`), {
        jobsOn, briefFor, tenantFilter: tenantId, triggerSource: 'manual',
      });
      res.json({ data: summary });
    } catch (err) {
      console.error('[review-replies:run]', err);
      fail(res, 500, 'INTERNAL_ERROR', err.message);
    }
  });

  router.post('/:id/approve', async (req, res) => {
    const tenantId = req.tenant.tenantId;
    const { id } = req.params;
    if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', WORDS.notWaiting);
    const edited = req.body?.body == null ? null : String(req.body.body);
    if (edited != null && !edited.trim()) return fail(res, 400, 'BAD_REQUEST', WORDS.emptyBody);
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('t', sql.UniqueIdentifier, tenantId)
        .query(`SELECT d.draft_id, d.site_id, d.gbp_review_id, d.reply_text, d.star_rating, d.review_text,
                       d.status, s.gbp_oauth_token_ref, s.gbp_location_name
                  FROM arion.gbp_reply_draft d
                  JOIN arion.site s ON s.site_id = d.site_id AND s.tenant_id = d.tenant_id
                 WHERE d.draft_id = @id AND d.tenant_id = @t AND d.status IN ('held','failed')`);
      const row = r.recordset[0];
      if (!row) return fail(res, 404, 'NOT_FOUND', WORDS.notWaiting);

      // 1. Has somebody answered it on Google since? Never post blind.
      const google = api();
      let data;
      try { data = await google.fetchReviews(row.gbp_oauth_token_ref, row.gbp_location_name); } catch (e) { data = { error: e.message }; }
      if (!data || data.error) return fail(res, 503, 'GOOGLE_UNREADABLE', WORDS.googleUnreadable);
      const live = (data.reviews || []).find((x) => String(x.reviewId) === String(row.gbp_review_id));
      if (live?.replyComment) {
        await markReply(pool, { draftId: id, tenantId, status: 'stood_down', decidedBy: personName(req) });
        return fail(res, 409, 'ALREADY_ANSWERED', WORDS.alreadyAnswered);
      }

      // 2. Edited words run the checks again.
      const text = edited != null ? edited.trim() : String(row.reply_text);
      if (edited != null && edited.trim() !== String(row.reply_text).trim()) {
        const read = await briefFor(tenantId);
        if (!read || read.ok !== true || !read.brief) return fail(res, 503, 'BRIEF_UNREADABLE', WORDS.briefUnreadable);
        const checked = runChecks(text, EDIT_CHECKS, checkContext(read.brief, { stars: row.star_rating, reviewText: row.review_text || '' }));
        if (!checked.ok) return fail(res, 409, 'UNKNOWN_CHECK', `ARGUS has no check called ${checked.unknown[0]}, so I did nothing.`);
        if (checked.fired.length) return fail(res, 409, 'CHECK_FIRED', checked.fired[0].words);
      }

      // 3. Post, then move the status (guarded).
      let posted;
      try { posted = await google.replyToReview(row.gbp_oauth_token_ref, row.gbp_location_name, row.gbp_review_id, text); } catch (e) { posted = { error: e.message }; }
      if (!posted || posted.error) {
        await markReply(pool, { draftId: id, tenantId, status: 'failed', postError: WORDS.googleRefused });
        return fail(res, 502, 'GOOGLE_REFUSED', WORDS.googleRefused);
      }
      const moved = await markReply(pool, { draftId: id, tenantId, status: 'posted', replyFinal: text, decidedBy: personName(req) });
      if (!moved) return fail(res, 409, 'RACE', WORDS.raced);
      res.json({ data: { draft_id: id, status: 'posted', words: 'Posted your reply on Google.' } });
    } catch (err) {
      console.error('[review-replies:approve]', err);
      fail(res, 500, 'INTERNAL_ERROR', err.message);
    }
  });

  router.post('/:id/skip', async (req, res) => {
    const tenantId = req.tenant.tenantId;
    const { id } = req.params;
    if (!GUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', WORDS.notWaiting);
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
    try {
      const pool = await getPool();
      const r = await pool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('t', sql.UniqueIdentifier, tenantId)
        .input('reason', sql.NVarChar(500), reason)
        .input('by', sql.NVarChar(256), personName(req))
        .query(`UPDATE arion.gbp_reply_draft
                   SET status = 'skipped', skip_reason = @reason, decided_by = @by, decided_at = SYSDATETIMEOFFSET()
                 WHERE draft_id = @id AND tenant_id = @t AND status IN ('held','failed');
                SELECT @@ROWCOUNT AS affected;`);
      if (Number(r.recordset?.[0]?.affected) !== 1) return fail(res, 404, 'NOT_FOUND', WORDS.notWaiting);
      res.json({ data: { draft_id: id, status: 'skipped' } });
    } catch (err) {
      console.error('[review-replies:skip]', err);
      fail(res, 500, 'INTERNAL_ERROR', err.message);
    }
  });

  return router;
}

export default makeReviewRepliesRouter();
