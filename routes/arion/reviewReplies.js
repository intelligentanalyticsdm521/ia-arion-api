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
// AN EDITED REPLY IS CHECKED AGAIN, every check except the two holds that
// exist to make a person look: "3 stars or fewer waits for you" and "a
// complaint, a refund or anything legal waits for you". A person approving IS
// the asking, and the second one reads the REVIEW, so keeping it would refuse
// every edit to the replies that most need the owner's own words. A check
// that fires refuses with its sentence and nothing is posted.
//
// THE REPLY IS CLAIMED BEFORE IT IS POSTED: held/failed -> 'posting', guarded,
// exactly one row. Two approvals at the same moment: one posts, the other is
// told it was decided elsewhere and posts nothing. Then posted (or failed),
// moved from 'posting' only.

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { reviewsApi, NOT_LIVE_WORDS } from '../../lib/gbpFake.js';
import { siteRefreshToken, tokenColumnsSql } from '../../lib/gbpTokenAtRest.js';
import { runReviewReplyTick, markReply, claimReply, releaseReply, JOB_KEY, POSTING_STALE_MINUTES } from '../../lib/gbpReplyRunner.js';
import { jobsOn as seamJobsOn, briefFor as seamBriefFor } from '../../lib/teamSeam.js';
import { runChecks, PLATFORM_CHECKS, checkContext, RUN_WORDS } from '../../lib/jobChecks.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message, status } });

export const WORDS = Object.freeze({
  notWaiting: "That reply isn't waiting for you any more.",
  alreadyAnswered: "Someone already answered this review on Google, so I didn't post.",
  googleUnreadable: "I couldn't check Google just now, so I didn't post. Try again in a minute.",
  googleRefused: "Google didn't take this reply, so it's still waiting for you. Try again.",
  briefUnreadable: "I couldn't read your business details to check your changes, so I didn't post. Try again in a minute.",
  raced: 'That reply was decided somewhere else just now, so I posted nothing.',
  postedNotRecorded: "Your reply is on Google, but I couldn't record that here. It may still show as waiting; posting it again won't post it twice.",
  jobOff: 'Google review replies are off. Switch them on first.',
  jobUnreadable: "ARGUS couldn't check whether Google review replies are on, so nothing ran. Try again in a minute.",
  emptyBody: 'Write the reply first.',
  // A thrown error is logged, never sent: an owner reads these, not the exception.
  runBroke: 'Something went wrong on our side, so nothing ran. Try again in a minute.',
  serverError: 'Something went wrong on our side. Try again in a minute.',
});

/** Who decided, in a person's words. */
export function personName(req) {
  return req.auth?.name || req.auth?.email || req.auth?.preferred_username
    || (Array.isArray(req.auth?.emails) ? req.auth.emails[0] : null) || req.user?.email || null;
}

/** The holds that exist to make a person look; a person approving has looked. */
export const PERSON_IS_THE_ASK = Object.freeze(['low_star_review_asks', 'hold_complaint_legal_refund']);

/** The checks an edited reply runs again: the job's, minus the two "ask a person" holds. */
export const EDIT_CHECKS = Object.freeze(PLATFORM_CHECKS[JOB_KEY].filter((c) => !PERSON_IS_THE_ASK.includes(c)));

/**
 * Factory so tests can hand in a fake pool, a fake Google and fake readers.
 */
export function makeReviewRepliesRouter({
  getPool = getServicesPool,
  api = () => reviewsApi(),
  jobsOn = seamJobsOn,
  briefFor = seamBriefFor,
  tick = runReviewReplyTick,
  // The checks an edited reply runs again (EDIT_CHECKS); a test hands in one
  // this runner can't run to prove the refusal names it in plain words.
  editChecks = EDIT_CHECKS,
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
      // A run that could not start says why, as a refusal, never as an empty 200.
      const mineRun = (summary.runs || []).find((r) => String(r.tenantId).toUpperCase() === String(tenantId).toUpperCase());
      if (mineRun && (mineRun.outcome === 'blocked' || mineRun.outcome === 'failed') && mineRun.words) {
        return fail(res, 409, 'NOT_RUN', mineRun.words);
      }
      res.json({ data: summary });
    } catch (err) {
      console.error('[review-replies:run]', err);
      fail(res, 500, 'INTERNAL_ERROR', WORDS.runBroke);
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
        .input('stale', sql.Int, POSTING_STALE_MINUTES)
        .query(`SELECT d.draft_id, d.site_id, d.gbp_review_id, d.reply_text, d.star_rating, d.review_text,
                       d.status, ${tokenColumnsSql('s')}, s.gbp_location_name
                  FROM arion.gbp_reply_draft d
                  JOIN arion.site s ON s.site_id = d.site_id AND s.tenant_id = d.tenant_id
                 WHERE d.draft_id = @id AND d.tenant_id = @t
                   AND (d.status IN ('held','failed')
                        OR (d.status = 'posting' AND d.decided_at < DATEADD(MINUTE, -@stale, SYSDATETIMEOFFSET())))`);
      const row = r.recordset[0];
      if (!row) return fail(res, 404, 'NOT_FOUND', WORDS.notWaiting);

      // 1. Has somebody answered it on Google since? Never post blind.
      const google = api();
      let data;
      try { data = await google.fetchReviews(siteRefreshToken(row), row.gbp_location_name); } catch (e) { data = { error: e.message }; }
      if (!data || data.error) return fail(res, 503, 'GOOGLE_UNREADABLE', WORDS.googleUnreadable);
      const live = (data.reviews || []).find((x) => String(x.reviewId) === String(row.gbp_review_id));
      if (live?.replyComment) {
        await markReply(pool, { draftId: id, tenantId, status: 'stood_down', decidedBy: personName(req), from: row.status === 'posting' ? 'posting' : 'waiting' });
        return fail(res, 409, 'ALREADY_ANSWERED', WORDS.alreadyAnswered);
      }

      // 2. Edited words run the checks again.
      const text = edited != null ? edited.trim() : String(row.reply_text);
      if (edited != null && edited.trim() !== String(row.reply_text).trim()) {
        const read = await briefFor(tenantId);
        if (!read || read.ok !== true || !read.brief) return fail(res, 503, 'BRIEF_UNREADABLE', WORDS.briefUnreadable);
        const checked = runChecks(text, editChecks, checkContext(read.brief, { stars: row.star_rating, reviewText: row.review_text || '' }));
        if (!checked.ok) return fail(res, 409, 'UNKNOWN_CHECK', RUN_WORDS.unknownCheck(checked.unknown[0]));
        if (checked.fired.length) return fail(res, 409, 'CHECK_FIRED', checked.fired[0].words);
      }

      // 3. Claim it (guarded, exactly one row), THEN post, then move it on
      //    from 'posting'. The loser of a race posts nothing.
      const who = personName(req);
      if (!(await claimReply(pool, { draftId: id, tenantId, decidedBy: who }))) return fail(res, 409, 'RACE', WORDS.raced);
      const before = row.status === 'failed' ? 'failed' : 'held';
      let posted;
      try { posted = await google.replyToReview(siteRefreshToken(row), row.gbp_location_name, row.gbp_review_id, text); } catch (e) { posted = { error: e.message }; }
      if (!posted || posted.error) {
        // On a machine that is not the live service nothing is posted to Google
        // (lib/gbpFake.js); say exactly that rather than blaming Google, and
        // give the reply back unchanged.
        if (posted?.error === NOT_LIVE_WORDS) {
          await releaseReply(pool, { draftId: id, tenantId, toStatus: before });
          return fail(res, 409, 'NOT_LIVE', NOT_LIVE_WORDS);
        }
        await markReply(pool, { draftId: id, tenantId, status: 'failed', postError: WORDS.googleRefused, from: 'posting' });
        return fail(res, 502, 'GOOGLE_REFUSED', WORDS.googleRefused);
      }
      const moved = await markReply(pool, { draftId: id, tenantId, status: 'posted', replyFinal: text, decidedBy: who, from: 'posting' });
      if (!moved) {
        // Google took it; only the record failed to move. Say what happened.
        console.error(`[review-replies:approve] ${id}: posted on Google but the row did not move from posting`);
        return fail(res, 500, 'NOT_RECORDED', WORDS.postedNotRecorded);
      }
      res.json({ data: { draft_id: id, status: 'posted', words: 'Posted your reply on Google.' } });
    } catch (err) {
      console.error('[review-replies:approve]', err);
      fail(res, 500, 'INTERNAL_ERROR', WORDS.serverError);
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
        .input('stale', sql.Int, POSTING_STALE_MINUTES)
        .query(`UPDATE arion.gbp_reply_draft
                   SET status = 'skipped', skip_reason = @reason, decided_by = @by, decided_at = SYSDATETIMEOFFSET()
                 WHERE draft_id = @id AND tenant_id = @t
                   AND (status IN ('held','failed')
                        OR (status = 'posting' AND decided_at < DATEADD(MINUTE, -@stale, SYSDATETIMEOFFSET())));
                SELECT @@ROWCOUNT AS affected;`);
      if (Number(r.recordset?.[0]?.affected) !== 1) return fail(res, 404, 'NOT_FOUND', WORDS.notWaiting);
      res.json({ data: { draft_id: id, status: 'skipped' } });
    } catch (err) {
      console.error('[review-replies:skip]', err);
      fail(res, 500, 'INTERNAL_ERROR', WORDS.serverError);
    }
  });

  return router;
}

export default makeReviewRepliesRouter();
