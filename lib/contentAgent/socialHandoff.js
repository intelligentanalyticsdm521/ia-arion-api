// lib/contentAgent/socialHandoff.js — an approved social post goes to the
// business's social scheduler (SPARK → My Brand → Social).
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.6). Before this
// an approved social post stopped at "approved" and went nowhere: the
// publisher only knows the website.
//
// The scheduler lives in LUMEN. This calls its internal route
//   POST {LUMEN_API_BASE_URL}/api/v1/internal/my-brand/social/posts
//   x-internal-token: LUMEN_INTERNAL_SERVICE_TOKEN
//   { tenant_id, body, scheduled_for, approved_by }
// with LUMEN_API_BASE_URL (the address arion already uses for LUMEN,
// lib/brandIntakeClient.js) and the one shared internal secret; no new setting.
//
// IDEMPOTENT on scheduled_social_post_id: a second call for a post that was
// already handed off does nothing and says so. And CLAIMED FIRST: before the
// call to the scheduler, scheduled_social_post_id is set to a claim
// ('claim:<instant>') by a guarded UPDATE that must move exactly one row, so
// two "Try again" or approve presses at the same moment cannot both create a
// post. The claim becomes the real post id on success and is cleared on
// failure; a claim older than CLAIM_STALE_MS (the call timed out and the
// process died) may be taken over.
//
// NEVER SAYS "SCHEDULED" WHEN IT IS NOT. Any failure is written to
// handoff_error_plain and the post stays in Needs you with "Try again"; the
// answer is ok:false with the sentence. A post saved as a draft (no account
// connected) says exactly that. A time an owner reads is on the business's
// clock ("Fri 9 Oct, 10:00"), never a raw instant.

import sql from 'mssql';
import { platformInternalToken } from '../platformEnv.js';
import { businessTimeZone, whenWords } from '../businessTimeZone.js';

const TIMEOUT_MS = 8000;
export const CLAIM_STALE_MS = 2 * 60 * 1000;
const CLAIM_PREFIX = 'claim:';
const isClaim = (v) => String(v || '').startsWith(CLAIM_PREFIX);
const claimAge = (v) => Date.now() - Date.parse(String(v).slice(CLAIM_PREFIX.length));

function lumenBase(env) {
  return (env.LUMEN_API_BASE_URL || env.SPARK_API_BASE_URL || '').replace(/\/+$/, '');
}
// LUMEN's requireInternalServiceToken checks LUMEN_INTERNAL_SERVICE_TOKEN,
// which is the one shared internal secret (vault PLATFORM-INTERNAL-TOKEN; the
// same value as PLATFORM_INTERNAL_TOKEN, see lib/platformEnv.js). Read the
// LUMEN name first, then the canonical one.
function lumenToken(env) {
  return String(env.LUMEN_INTERNAL_SERVICE_TOKEN || '').trim() || platformInternalToken(env);
}

export const HANDOFF_WORDS = Object.freeze({
  not_configured: "Your social scheduler isn't reachable from here yet, so this post wasn't scheduled. Try again later.",
  unreachable: "Your social scheduler didn't answer, so this post wasn't scheduled. Try again.",
  not_approved: "That post isn't approved yet.",
  not_social: "That isn't a social post.",
  no_time: 'Pick when it should go out.',
  in_progress: 'This post is being handed to your social scheduler right now.',
  already: 'This post was already handed to your social scheduler.',
  scheduled: (when) => `Scheduled for ${when}.`,
});

async function recordError(pool, tenantId, outputId, words) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('err', sql.NVarChar(500), String(words).slice(0, 500))
    .query(`UPDATE arion.content_agent_output SET handoff_error_plain = @err
             WHERE tenant_id = @tenantId AND output_id = @id`);
}

/** Take the row for this hand-off, or learn somebody else has it. Must move exactly one row. */
async function claim(pool, tenantId, outputId, current) {
  const mine = `${CLAIM_PREFIX}${new Date().toISOString()}`;
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('claim', sql.NVarChar(100), mine)
    .input('prev', sql.NVarChar(100), current || null)
    .query(`UPDATE arion.content_agent_output SET scheduled_social_post_id = @claim
             WHERE tenant_id = @tenantId AND output_id = @id
               AND ((@prev IS NULL AND scheduled_social_post_id IS NULL)
                    OR (@prev IS NOT NULL AND scheduled_social_post_id = @prev));
            SELECT @@ROWCOUNT AS affected;`);
  return Number(r.recordset?.[0]?.affected) === 1 ? mine : null;
}

/** Let the claim go (the hand-off failed); only our own claim is cleared. */
async function release(pool, tenantId, outputId, mine) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('claim', sql.NVarChar(100), mine)
    .query(`UPDATE arion.content_agent_output SET scheduled_social_post_id = NULL
             WHERE tenant_id = @tenantId AND output_id = @id AND scheduled_social_post_id = @claim`);
}

/**
 * Hand one approved social post to the scheduler.
 * @returns {Promise<{ ok: boolean, already?: boolean, post_id?: string, status?: string, words: string }>}
 */
export async function handoffSocial(pool, {
  tenantId, outputId, scheduledFor, approvedBy, fetchImpl = fetch, env = process.env, timeZone = businessTimeZone,
}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .query(`SELECT output_id, content_type, review_status, body_markdown, body_markdown_final,
                   scheduled_social_post_id
              FROM arion.content_agent_output
             WHERE tenant_id = @tenantId AND output_id = @id`);
  const row = r.recordset[0];
  if (!row) return { ok: false, words: "That post isn't waiting for you any more." };
  if (row.content_type !== 'social_post' && row.content_type !== 'social_carousel') return { ok: false, words: HANDOFF_WORDS.not_social };
  const current = row.scheduled_social_post_id ? String(row.scheduled_social_post_id) : null;
  if (current && !isClaim(current)) {
    return { ok: true, already: true, post_id: current, words: HANDOFF_WORDS.already };
  }
  if (current && isClaim(current) && !(claimAge(current) > CLAIM_STALE_MS)) {
    return { ok: false, in_progress: true, words: HANDOFF_WORDS.in_progress };
  }
  if (row.review_status !== 'approved' && row.review_status !== 'edited') return { ok: false, words: HANDOFF_WORDS.not_approved };
  const when = scheduledFor ? new Date(scheduledFor) : null;
  if (!when || Number.isNaN(when.getTime())) return { ok: false, words: HANDOFF_WORDS.no_time };

  const base = lumenBase(env);
  const token = lumenToken(env);
  if (!base || !token) {
    await recordError(pool, tenantId, outputId, HANDOFF_WORDS.not_configured);
    return { ok: false, words: HANDOFF_WORDS.not_configured };
  }

  // Claim it first. The loser of a race creates nothing.
  const mine = await claim(pool, tenantId, outputId, current);
  if (!mine) return { ok: false, in_progress: true, words: HANDOFF_WORDS.in_progress };

  let res;
  let body = null;
  try {
    res = await fetchImpl(`${base}/api/v1/internal/my-brand/social/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({
        tenant_id: String(tenantId),
        body: row.body_markdown_final ?? row.body_markdown,
        scheduled_for: when.toISOString(),
        approved_by: approvedBy || null,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(`[social-handoff] ${outputId}: ${err.message}`);
    await release(pool, tenantId, outputId, mine);
    await recordError(pool, tenantId, outputId, HANDOFF_WORDS.unreachable);
    return { ok: false, words: HANDOFF_WORDS.unreachable };
  }

  const payload = body?.data ?? body;
  if (!res.ok || !payload?.post_id) {
    const words = payload?.error?.message || body?.error?.message || payload?.words || HANDOFF_WORDS.unreachable;
    await release(pool, tenantId, outputId, mine);
    await recordError(pool, tenantId, outputId, words);
    return { ok: false, words };
  }

  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('post', sql.NVarChar(100), String(payload.post_id))
    .input('claim', sql.NVarChar(100), mine)
    .query(`UPDATE arion.content_agent_output
               SET scheduled_social_post_id = @post, handoff_error_plain = NULL
             WHERE tenant_id = @tenantId AND output_id = @id AND scheduled_social_post_id = @claim`);
  let words = payload.words || null;
  if (!words) {
    const tz = await timeZone(pool, tenantId);
    words = HANDOFF_WORDS.scheduled(whenWords(when, tz));
  }
  return {
    ok: true,
    post_id: String(payload.post_id),
    status: payload.status || null,
    words,
  };
}

export default { HANDOFF_WORDS, CLAIM_STALE_MS, handoffSocial };
