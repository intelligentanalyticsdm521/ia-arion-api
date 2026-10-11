// lib/gbpReplyRunner.js — the web person's "Google review replies" job.
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.1). Replaces
// lib/gbpAutoReplyRunner.js, which posted every reply it wrote with no
// approval step at all (finding: gbpAutoReplyRunner.js:82) and silently never
// drafted a review below the owner's star line (finding F8).
//
// THE APPROVAL STEP. Every reply is written to arion.gbp_reply_draft FIRST
// (status 'held'), then decided, in this order:
//   1. 3 stars or fewer           -> held, low_star (always waits for the owner)
//   2. any check fired            -> held, check:<name>
//   3. the job is Send me first   -> held, send_me_first (also when the pinned
//      playbook's last step holds 'always')
//   4. Automatic and stars >= the owner's automatic_min_stars
//                                 -> posted now, decided_by "Approved in advance by …"
//   5. otherwise (a 4-star review with the line at 5) -> held, not_automatic_stars
// A post that Google refuses leaves the row 'failed' with the sentence; it
// shows in Needs you with "Try again".
//
// ONE REPLY PER REVIEW, EVER: the row is keyed (site_id, gbp_review_id)
// UNIQUE, and a review that already has a row is never drafted again.
//
// WHO RUNS: every business with the job switched ON (jobsOn), then the
// ownership check, then its connected sites on ARION Pro or above. When the
// switches cannot be read, nothing runs and the summary says why (fail
// closed; the opposite direction from the ownership check on purpose, F9).
//
// AC7: one arion.gbp_reply_run row per business per tick, written first and
// closed on every exit path with plain-sentence notes.
//
// Triggered by the arion-func timer through POST /internal/gbp-auto-reply-tick
// (unchanged path, so arion-func does not change) and by "Run it now".

import sql from 'mssql';
import { draftReviewReply } from './gbpAiReply.js';
import { meetsMinTier } from './tierCheck.js';
import { checkOwnership, ownershipSummary } from './productOwnership.js';
import { purchasedArionTier, effectiveArionTier } from './purchasedArionTier.js';
import { reviewsApi, NOT_LIVE_WORDS } from './gbpFake.js';
import { siteRefreshToken, tokenColumnsSql, hasSiteTokenSql } from './gbpTokenAtRest.js';
import { jobsOn as seamJobsOn, briefFor as seamBriefFor } from './teamSeam.js';
import { suiteCeilingCheck, markCeilingBreached } from './argus/suiteCeiling.js';
import {
  JOB, HELD_WORDS, RUN_WORDS, runChecks, conforms, checksFor, lastHold, unknownChecksFor,
  readsOf, briefValue, briefCitation, checkContext, effectiveMode, approvedInAdvanceWords,
} from './jobChecks.js';

/** The sentences this runner writes on a run row (History reads them). */
export const REVIEW_RUN_WORDS = Object.freeze({
  NOT_CONNECTED: 'Connect your Google Business Profile first.',
  NOT_PRO: 'Google review replies come with ARION Pro.',
  SPEND_OFF: "ARGUS spending is switched off right now, so I didn't write any replies.",
  NOT_PRICED: "Review replies can't be paid for yet, so I didn't write any.",
  CEILING: "This month's ARGUS spending limit for your business is reached, so I didn't write any replies.",
  NO_CREDITS: "Your ARGUS credits ran out, so I stopped answering reviews until they're topped up.",
  GOOGLE_UNREADABLE: "I couldn't read your Google reviews this time, so I'll look again tomorrow.",
  NOTHING_NEW: 'No new reviews to answer.',
});

/** The priced action this job spends on: agent spend, inside the suite limit (lib/argus/suiteCeiling.js AGENT_ACTIONS). */
export const REVIEW_REPLY_ACTION = 'arion.review_reply';
export const MAX_REPLIES_PER_SITE_PER_TICK = 10;   // a cap on spend and on Google's rate
export const JOB_KEY = JOB.REVIEWS;

const clampStars = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 4;
  return Math.min(5, Math.max(4, Math.round(n)));   // never below 4 (§D.4 rule 7)
};

/**
 * Decide what happens to one drafted reply. Pure.
 * @returns {{ status: 'held'|'post', reason: string|null, words: string|null }}
 */
export function decideReply({ stars, fired, mode, hold, minStars }) {
  if (!Number.isFinite(Number(stars)) || Number(stars) <= 3) return { status: 'held', reason: 'low_star', words: HELD_WORDS.low_star };
  const other = (fired || []).filter((f) => f.check !== 'low_star_review_asks');
  if (other.length) return { status: 'held', reason: `check:${other[0].check}`, words: other[0].words };
  if (hold === 'always') return { status: 'held', reason: 'always_asks', words: HELD_WORDS.always_asks };
  if (mode !== 'automatic') return { status: 'held', reason: 'send_me_first', words: HELD_WORDS.send_me_first };
  if (Number(stars) >= clampStars(minStars)) return { status: 'post', reason: null, words: null };
  return { status: 'held', reason: 'not_automatic_stars', words: HELD_WORDS.not_automatic_stars };
}

async function openRun(pool, { tenantId, triggerSource, playbookVersion }) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('trigger', sql.NVarChar(20), triggerSource)
    .input('pbv', sql.Int, playbookVersion ?? null)
    .query(`INSERT INTO arion.gbp_reply_run (tenant_id, trigger_source, status, playbook_version)
            OUTPUT INSERTED.run_id
            VALUES (@t, @trigger, 'running', @pbv)`);
  return r.recordset[0].run_id;
}

async function closeRun(pool, runId, { status, outcome, counts = {}, notes = [], error = null, costUsd = 0 }) {
  await pool.request()
    .input('id', sql.UniqueIdentifier, runId)
    .input('status', sql.NVarChar(20), status)
    .input('outcome', sql.NVarChar(40), outcome)
    .input('seen', sql.Int, counts.seen ?? null)
    .input('drafted', sql.Int, counts.drafted ?? null)
    .input('held', sql.Int, counts.held ?? null)
    .input('posted', sql.Int, counts.posted ?? null)
    .input('notes', sql.NVarChar(sql.MAX), JSON.stringify(notes))
    .input('err', sql.NVarChar(500), error ? String(error).slice(0, 500) : null)
    // The governance registration (migration 069) names cost_usd as this
    // job's cost column: every run writes what it spent, 0 when nothing.
    .input('cost', sql.Decimal(10, 6), Number((Number(costUsd) || 0).toFixed(6)))
    .query(`UPDATE arion.gbp_reply_run
               SET status = @status, outcome = @outcome, reviews_seen = @seen, drafted = @drafted,
                   held = @held, posted = @posted, notes_json = @notes, error_plain = @err,
                   cost_usd = @cost, finished_at = SYSDATETIMEOFFSET()
             WHERE run_id = @id`);
}

/** One run row opened and closed at once: a business the job could not work for, with the reason. */
async function blockedRun(pool, { tenantId, triggerSource, playbookVersion, words, status = 'skipped', outcome = 'blocked', error = null }) {
  const runId = await openRun(pool, { tenantId, triggerSource, playbookVersion });
  await closeRun(pool, runId, { status, outcome, notes: [words], error });
  return runId;
}

/**
 * The outcome of a finished run. Nothing drafted is "nothing to do" ONLY when
 * nothing went wrong: a run that couldn't read Google or ran out of credits
 * before writing a word is BLOCKED, and History says the real reason.
 */
export function runOutcome(counts, notes) {
  if (counts.drafted) return 'worked';
  return notes.length ? 'blocked' : 'nothing_due';
}

async function loadSites(pool, tenantIds) {
  if (!tenantIds.length) return [];
  const req = pool.request();
  const names = tenantIds.map((id, i) => { req.input(`t${i}`, sql.UniqueIdentifier, id); return `@t${i}`; });
  const r = await req.query(`
    SELECT tenant_id, site_id, arion_tier, gbp_location_name, ${tokenColumnsSql()}
      FROM arion.site
     WHERE tenant_id IN (${names.join(', ')})
       AND gbp_connected = 1
       AND ${hasSiteTokenSql()}
       AND gbp_location_name IS NOT NULL`);
  return r.recordset || [];
}

/** Why a business with the job on has no site this job can work on (one sentence). */
export function noSiteWords(connectedSites) {
  return connectedSites.length ? REVIEW_RUN_WORDS.NOT_PRO : REVIEW_RUN_WORDS.NOT_CONNECTED;
}

async function answeredHere(pool, siteId) {
  const r = await pool.request()
    .input('s', sql.UniqueIdentifier, siteId)
    .query('SELECT gbp_review_id FROM arion.gbp_reply_draft WHERE site_id = @s');
  return new Set((r.recordset || []).map((x) => String(x.gbp_review_id)));
}

async function insertDraft(pool, row) {
  try {
    const r = await pool.request()
      .input('run', sql.UniqueIdentifier, row.runId)
      .input('t', sql.UniqueIdentifier, row.tenantId)
      .input('s', sql.UniqueIdentifier, row.siteId)
      .input('rid', sql.NVarChar(200), row.reviewId)
      .input('who', sql.NVarChar(200), row.reviewerName)
      .input('stars', sql.TinyInt, row.stars)
      .input('rtext', sql.NVarChar(sql.MAX), row.reviewText)
      .input('reply', sql.NVarChar(sql.MAX), row.replyText)
      .input('reason', sql.NVarChar(40), row.heldReason)
      .input('words', sql.NVarChar(300), row.heldWords)
      .input('flags', sql.NVarChar(sql.MAX), JSON.stringify(row.flags || []))
      .input('cited', sql.NVarChar(sql.MAX), JSON.stringify(row.cited))
      // 'held' waits for the owner; 'posting' is a reply approved in advance
      // that is being posted right now (decided_at = when the post started).
      // A posting row that never hears back reads "I started posting this…",
      // never "Send me first" (it was not held).
      .input('status', sql.NVarChar(12), row.status === 'posting' ? 'posting' : 'held')
      .input('by', sql.NVarChar(256), row.status === 'posting' ? row.decidedBy || null : null)
      .query(`INSERT INTO arion.gbp_reply_draft
                (run_id, tenant_id, site_id, gbp_review_id, reviewer_name, star_rating, review_text,
                 reply_text, status, held_reason, held_words, flags_json, brief_cited_json,
                 decided_by, decided_at)
              OUTPUT INSERTED.draft_id
              VALUES (@run, @t, @s, @rid, @who, @stars, @rtext, @reply, @status, @reason, @words, @flags, @cited,
                      @by, CASE WHEN @status = 'posting' THEN SYSDATETIMEOFFSET() ELSE NULL END)`);
    return r.recordset[0].draft_id;
  } catch (err) {
    // The UNIQUE (site_id, gbp_review_id) is "once per review": another tick
    // got here first. Anything else is a real failure and is thrown.
    if (err && (err.number === 2627 || err.number === 2601 || /duplicate key|UNIQUE/i.test(err.message || ''))) return null;
    throw err;
  }
}

/** How long a 'posting' claim holds before a person may take it over (the post timed out). */
export const POSTING_STALE_MINUTES = 2;

/** The statuses a reply may move FROM, by who is moving it. */
const FROM = Object.freeze({
  waiting: "status IN ('held','failed')",
  posting: "status = 'posting'",
});

/**
 * Move a reply. Guarded on the status it may move from; must move one row.
 * `from: 'waiting'` (held or failed: a person's skip or stand-down) or
 * `from: 'posting'` (the post this caller claimed came back).
 */
export async function markReply(pool, { draftId, tenantId, status, replyFinal = null, decidedBy = null, postError = null, from = 'waiting' }) {
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, draftId)
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('status', sql.NVarChar(12), status)
    .input('final', sql.NVarChar(sql.MAX), replyFinal)
    .input('by', sql.NVarChar(256), decidedBy)
    .input('err', sql.NVarChar(500), postError ? String(postError).slice(0, 500) : null)
    .query(`UPDATE arion.gbp_reply_draft
               SET status = @status,
                   reply_final = COALESCE(@final, reply_final),
                   decided_by = COALESCE(@by, decided_by),
                   decided_at = CASE WHEN @status IN ('posted','skipped','stood_down') THEN SYSDATETIMEOFFSET() ELSE decided_at END,
                   post_error_plain = @err
             WHERE draft_id = @id AND tenant_id = @t AND ${FROM[from] || FROM.waiting};
            SELECT @@ROWCOUNT AS affected;`);
  return Number(r.recordset?.[0]?.affected) === 1;
}

/**
 * CLAIM a waiting reply before posting it (a person's "Post this reply").
 * Two approvals at the same moment: exactly one moves the row to 'posting'
 * and posts; the other is told it was decided elsewhere and posts NOTHING. A
 * claim that never came back (the process died mid-post) may be taken over
 * after POSTING_STALE_MINUTES; the approve re-reads Google first, so a reply
 * Google did take is stood down rather than posted twice.
 */
export async function claimReply(pool, { draftId, tenantId, decidedBy }) {
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, draftId)
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('by', sql.NVarChar(256), decidedBy)
    .input('stale', sql.Int, POSTING_STALE_MINUTES)
    .query(`UPDATE arion.gbp_reply_draft
               SET status = 'posting', decided_by = @by, decided_at = SYSDATETIMEOFFSET(), post_error_plain = NULL
             WHERE draft_id = @id AND tenant_id = @t
               AND (status IN ('held','failed')
                    OR (status = 'posting' AND decided_at < DATEADD(MINUTE, -@stale, SYSDATETIMEOFFSET())));
            SELECT @@ROWCOUNT AS affected;`);
  return Number(r.recordset?.[0]?.affected) === 1;
}

/** Give a claimed reply back to the owner, unchanged (nothing was posted). */
export async function releaseReply(pool, { draftId, tenantId, toStatus = 'held' }) {
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, draftId)
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('to', sql.NVarChar(12), toStatus === 'failed' ? 'failed' : 'held')
    .query(`UPDATE arion.gbp_reply_draft SET status = @to, decided_at = NULL
             WHERE draft_id = @id AND tenant_id = @t AND status = 'posting';
            SELECT @@ROWCOUNT AS affected;`);
  return Number(r.recordset?.[0]?.affected) === 1;
}

/**
 * Is the platform's spend for this job a STOP? The job never drafts for free:
 * spend switched off, or no price row for the action, stops this business.
 */
export function spendStop(code) {
  if (code === 'argus_spend_disabled') return REVIEW_RUN_WORDS.SPEND_OFF;
  if (code === 'unknown_action') return REVIEW_RUN_WORDS.NOT_PRICED;
  if (code === 'insufficient_credits') return REVIEW_RUN_WORDS.NO_CREDITS;
  return null;
}

/**
 * One tick.
 * @param {object} pool  the services pool
 * @param {Function} log
 * @param {object} deps  test seams (each defaults to the real thing)
 */
export async function runReviewReplyTick(pool, log = () => {}, deps = {}) {
  const {
    ownership = checkOwnership,
    jobsOn = seamJobsOn,
    briefFor = seamBriefFor,
    api = reviewsApi(),
    draft = draftReviewReply,
    tenantFilter = null,
    triggerSource = 'timer',
    callImpl = null,
    ceiling = suiteCeilingCheck,
    markBreached = markCeilingBreached,
    // The ARION tier the business PAYS for (platform-api payload). Test seam.
    arionTierFor = purchasedArionTier,
  } = deps;
  const summary = {
    tenants: 0, sitesEligible: 0, drafted: 0, held: 0, posted: 0, failed: 0,
    skippedInsufficientCredits: 0, runs: [], errors: [], productOff: { skipped: [] },
  };

  const state = await jobsOn([JOB_KEY], tenantFilter ? { tenantId: tenantFilter } : {});
  if (!state || state.ok !== true || !(state.on instanceof Map)) {
    const why = state?.error || 'no answer';
    console.error(`[review-replies] ${RUN_WORDS.JOB_STATE_UNREADABLE} (${why})`);
    return { ...summary, jobStateUnreadable: true, words: RUN_WORDS.JOB_STATE_UNREADABLE, error: why };
  }
  const only = tenantFilter ? String(tenantFilter).toUpperCase() : null;
  const jobs = new Map();
  for (const [t, inner] of state.on) {
    const T = String(t).toUpperCase();
    if (only && T !== only) continue;
    if (inner instanceof Map && inner.has(JOB_KEY)) jobs.set(T, inner.get(JOB_KEY));
  }
  const tenantIds = [...jobs.keys()];

  // Access follows the subscription (scope 2026-10-07 §4.3). Unknown = runs as before.
  const verdict = await ownership('arion', tenantIds);
  const runFor = new Set(verdict.owned.map((id) => String(id).toUpperCase()));
  summary.productOff = ownershipSummary(verdict, 'no Google review was answered');
  for (const s of summary.productOff.skipped) log(`business ${s.tenantId}: skipped — ${s.note}`);

  const sites = await loadSites(pool, tenantIds.filter((t) => runFor.has(t)));
  for (const T of tenantIds) {
    if (!runFor.has(T)) continue;
    const js = jobs.get(T);
    const tenantId = js.tenantId || T;
    // Pro or above, re-checked every tick so a downgrade stops it (§C.3).
    // BY THE SUBSCRIPTION (Brandon, 11 Oct 2026: "ARION pro has different
    // features than ARION lite"): the tier the business pays for, from the
    // platform-api payload, stands. arion.site.arion_tier is raise-only, so a
    // business that moved down to Lite still had 'pro' on its site row and kept
    // getting public Google replies written and paid for. The site row is only
    // the fallback when the subscription carries no tier.
    const connected = sites.filter((s) => String(s.tenant_id).toUpperCase() === T);
    const purchased = await arionTierFor(tenantId);
    const mine = connected.filter((s) => meetsMinTier(effectiveArionTier(purchased, s.arion_tier), 'pro'));
    if (!mine.length) {
      // The job is on but there is nothing it can work on: one run row with
      // the reason, so History (and Run it now) says why nothing happened.
      const words = noSiteWords(connected);
      const runId = await blockedRun(pool, { tenantId, triggerSource, playbookVersion: js.playbook?.version, words });
      summary.runs.push({ tenantId, runId, outcome: 'blocked', words });
      continue;
    }
    summary.tenants += 1;
    summary.sitesEligible += mine.length;

    // The suite spending limit (argus.governance_cost_config, §C.4), before
    // anything is read or written. A ceiling that cannot be read is a named
    // verdict that is allowed and noted (lib/argus/suiteCeiling.js says why).
    const suite = await ceiling(pool, tenantId);
    if (!suite.allowed) {
      await markBreached(pool, tenantId, suite.message).catch((e) => console.error(`[review-replies] could not record the ceiling breach for ${tenantId}: ${e.message}`));
      const runId = await blockedRun(pool, { tenantId, triggerSource, playbookVersion: js.playbook?.version, words: REVIEW_RUN_WORDS.CEILING, error: suite.message });
      summary.runs.push({ tenantId, runId, outcome: 'blocked', words: REVIEW_RUN_WORDS.CEILING });
      continue;
    }

    const runId = await openRun(pool, { tenantId, triggerSource, playbookVersion: js.playbook?.version });
    const notes = [];
    const counts = { seen: 0, drafted: 0, held: 0, posted: 0 };
    let costUsd = 0;
    try {
      const def = js.playbook?.def;
      if (!conforms(def, JOB_KEY)) {
        await closeRun(pool, runId, { status: 'failed', outcome: 'failed', notes: [RUN_WORDS.STEPS_MISMATCH], error: RUN_WORDS.STEPS_MISMATCH });
        summary.runs.push({ tenantId, runId, outcome: 'failed', words: RUN_WORDS.STEPS_MISMATCH });
        continue;
      }
      const names = checksFor(def, JOB_KEY);
      // Known means THIS runner runs it (§D.7 rule 3), never "some runner has it".
      const unknown = unknownChecksFor(JOB_KEY, names);
      if (unknown.length) {
        const words = RUN_WORDS.unknownCheck(unknown[0]);
        await closeRun(pool, runId, { status: 'failed', outcome: 'failed', notes: [words], error: words });
        summary.runs.push({ tenantId, runId, outcome: 'failed', words });
        continue;
      }

      const read = await briefFor(tenantId);
      if (!read || read.ok !== true || !read.brief) {
        console.error(`[review-replies] tenant ${tenantId}: ${RUN_WORDS.BRIEF_UNREADABLE_REVIEWS} (${read?.error || 'no answer'})`);
        await closeRun(pool, runId, { status: 'skipped', outcome: 'blocked', notes: [RUN_WORDS.BRIEF_UNREADABLE_REVIEWS], error: read?.error || null });
        summary.runs.push({ tenantId, runId, outcome: 'blocked', words: RUN_WORDS.BRIEF_UNREADABLE_REVIEWS });
        continue;
      }
      const brief = read.brief;
      const reads = readsOf(def);
      const cited = briefCitation(brief, reads);
      const pick = (api) => (reads.includes(api) ? briefValue(brief, api) : null);
      const draftBrief = {
        brandVoice: pick('brandVoice'), doNotSay: pick('doNotSay'),
        offersAllowed: pick('offersAllowed'), namesNeverMention: pick('namesNeverMention'),
        businessName: pick('businessName'),
      };
      const mode = effectiveMode(js);
      const hold = lastHold(def);
      const minStars = clampStars(js.vars?.automatic_min_stars);
      const inAdvance = approvedInAdvanceWords(js);

      siteLoop:
      for (const site of mine) {
        let data;
        try {
          data = await api.fetchReviews(siteRefreshToken(site), site.gbp_location_name);
        } catch (e) {
          data = { error: e.message };
        }
        if (!data || data.error) {
          notes.push(REVIEW_RUN_WORDS.GOOGLE_UNREADABLE);
          summary.errors.push(`fetchReviews ${site.site_id}: ${data?.error || 'no answer'}`);
          continue;
        }
        const done = await answeredHere(pool, site.site_id);
        const candidates = (data.reviews || [])
          .filter((r) => r && r.reviewId && !r.replyComment && !done.has(String(r.reviewId)))
          .slice(0, MAX_REPLIES_PER_SITE_PER_TICK);
        counts.seen += candidates.length;

        for (const review of candidates) {
          const out = await draft({ pool, tenantId, userId: null, review, brief: draftBrief, actionType: REVIEW_REPLY_ACTION, ...(callImpl ? { callImpl } : {}) });
          costUsd += Number(out?.costUsd) || 0;
          if (!out?.ok) {
            // Spend limits: switched off, not priced, or out of credits stops
            // THIS business for this tick. The job never drafts for free.
            const stop = spendStop(out?.code);
            if (stop) {
              if (out.code === 'insufficient_credits') summary.skippedInsufficientCredits += 1;
              notes.push(stop);
              break siteLoop;
            }
            notes.push("I couldn't write a reply to one review this time.");
            summary.errors.push(`draft ${site.site_id}/${review.reviewId}: ${out?.code || 'no answer'}`);
            continue;
          }
          const text = String(out.draft || '').trim();
          if (!text) { notes.push('One reply came back empty, so I left that review for next time.'); continue; }
          const stars = Number(review.starRating);
          const checked = runChecks(text, names, checkContext(brief, { stars, reviewText: review.comment || '' }));
          const decision = decideReply({ stars, fired: checked.fired, mode, hold, minStars });
          const draftId = await insertDraft(pool, {
            runId, tenantId, siteId: site.site_id, reviewId: String(review.reviewId),
            reviewerName: review.reviewerName || null, stars: Number.isFinite(stars) ? stars : 0,
            reviewText: review.comment || null, replyText: text,
            status: decision.status === 'held' ? 'held' : 'posting',
            decidedBy: decision.status === 'held' ? null : inAdvance,
            heldReason: decision.status === 'held' ? decision.reason : null,
            heldWords: decision.status === 'held' ? decision.words : null,
            flags: checked.fired, cited,
          });
          if (!draftId) continue;   // another tick wrote this review's reply first
          counts.drafted += 1;
          summary.drafted += 1;

          if (decision.status === 'held') {
            counts.held += 1;
            summary.held += 1;
            continue;
          }
          // Automatic, at or above the owner's line: approved in advance.
          let posted;
          try {
            posted = await api.replyToReview(siteRefreshToken(site), site.gbp_location_name, review.reviewId, text);
          } catch (e) {
            posted = { error: e.message };
          }
          if (!posted || posted.error) {
            const why = posted?.error === NOT_LIVE_WORDS ? NOT_LIVE_WORDS : "Google didn't take this reply when I tried to post it.";
            await markReply(pool, { draftId, tenantId, status: 'failed', postError: why, from: 'posting' });
            summary.failed += 1;
            counts.held += 1;
            notes.push("Google didn't take one reply, so it's waiting for you to try again.");
            continue;
          }
          await markReply(pool, { draftId, tenantId, status: 'posted', replyFinal: text, decidedBy: inAdvance, from: 'posting' });
          counts.posted += 1;
          summary.posted += 1;
          log(`replied ${site.site_id} review=${review.reviewId} (${stars} stars) — ${inAdvance}`);
        }
      }

      const outcome = runOutcome(counts, notes);
      if (outcome === 'nothing_due') notes.push(REVIEW_RUN_WORDS.NOTHING_NEW);
      await closeRun(pool, runId, { status: 'completed', outcome, counts, notes, costUsd });
      summary.runs.push({ tenantId, runId, outcome, ...counts, ...(outcome === 'blocked' ? { words: notes[0] } : {}) });
    } catch (err) {
      console.error(`[review-replies] tenant ${tenantId}: ${err.message}`);
      await closeRun(pool, runId, { status: 'failed', outcome: 'failed', counts, notes, error: err.message, costUsd })
        .catch((e) => console.error(`[review-replies] could not close run ${runId}: ${e.message}`));
      summary.errors.push(`tenant ${tenantId}: ${err.message}`);
      summary.runs.push({ tenantId, runId, outcome: 'failed', error: err.message });
    }
  }
  return summary;
}

export default {
  JOB_KEY, MAX_REPLIES_PER_SITE_PER_TICK, POSTING_STALE_MINUTES, REVIEW_RUN_WORDS,
  decideReply, markReply, claimReply, releaseReply, spendStop, runOutcome, noSiteWords, runReviewReplyTick,
};
