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
// already handed off does nothing and says so.
//
// NEVER SAYS "SCHEDULED" WHEN IT IS NOT. Any failure is written to
// handoff_error_plain and the post stays in Needs you with "Try again"; the
// answer is ok:false with the sentence. A post saved as a draft (no account
// connected) says exactly that.

import sql from 'mssql';
import { platformInternalToken } from '../platformEnv.js';

const TIMEOUT_MS = 8000;

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
});

async function recordError(pool, tenantId, outputId, words) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('err', sql.NVarChar(500), String(words).slice(0, 500))
    .query(`UPDATE arion.content_agent_output SET handoff_error_plain = @err
             WHERE tenant_id = @tenantId AND output_id = @id`);
}

/**
 * Hand one approved social post to the scheduler.
 * @returns {Promise<{ ok: boolean, already?: boolean, post_id?: string, status?: string, words: string }>}
 */
export async function handoffSocial(pool, {
  tenantId, outputId, scheduledFor, approvedBy, fetchImpl = fetch, env = process.env,
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
  if (row.scheduled_social_post_id) {
    return { ok: true, already: true, post_id: String(row.scheduled_social_post_id), words: 'This post was already handed to your social scheduler.' };
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
    await recordError(pool, tenantId, outputId, HANDOFF_WORDS.unreachable);
    return { ok: false, words: HANDOFF_WORDS.unreachable };
  }

  const payload = body?.data ?? body;
  if (!res.ok || !payload?.post_id) {
    const words = payload?.error?.message || body?.error?.message || payload?.words || HANDOFF_WORDS.unreachable;
    await recordError(pool, tenantId, outputId, words);
    return { ok: false, words };
  }

  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('post', sql.NVarChar(100), String(payload.post_id))
    .query(`UPDATE arion.content_agent_output
               SET scheduled_social_post_id = @post, handoff_error_plain = NULL
             WHERE tenant_id = @tenantId AND output_id = @id AND scheduled_social_post_id IS NULL`);
  return {
    ok: true,
    post_id: String(payload.post_id),
    status: payload.status || null,
    words: payload.words || `Scheduled for ${when.toISOString()}.`,
  };
}

export default { HANDOFF_WORDS, handoffSocial };
