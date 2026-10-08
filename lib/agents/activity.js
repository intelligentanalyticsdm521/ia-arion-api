// lib/agents/activity.js — the ARION read model behind Settings -> ARION ->
// Agents.
//
// The third copy of a shape that already exists twice — oliver-api
// lib/agents/activity.js and LUMEN src/lib/agentActivity/spark.js — and copied
// on purpose, because the point of that shape is that the PORTAL learns one
// vocabulary and each product's normaliser lives next to its own tables. A new
// agent gets a surface by adding a normaliser here, not by teaching the Portal a
// fourth set of status words.
//
// The rules are the other two files' rules, restated so this file can be read
// alone:
//
//   AG-1  A client NEVER sees cost_usd. It is IA's provider cost basis and
//         putting it on a customer's screen publishes the margin. The client
//         gets `cost_note`, in words. The founder's dollars live on the founder
//         rollup in LUMEN, where the whole page is founder-only.
//   AG-2  Four statuses — proposed | approved | declined | stopped — plus a
//         per-agent plain-words label written by whoever knows what the agent
//         actually did. There is deliberately no `sent`: for this agent an
//         approval creates a SCHEDULED WordPress post and publishing is a
//         separate, explicit second step, so "sent" would be a lie.
//   F1    A source whose table is missing lands in meta.degraded. Never a 500,
//         never a silently empty list.
//
// ESCALATED UNITS ARE KEPT VISIBLY APART. The route's queue endpoint already
// returns them in their own collection (AC2); this read model marks them with
// their own status_label and `can_decide: false`, so a page that renders the
// merged list still cannot present a withheld draft as ready to approve.

import sql from 'mssql';
import { JOB, EMPLOYEE_KEY, HELD_WORDS, jobForContentType } from '../jobChecks.js';
import { heldWordsFromFlags } from '../contentAgent/decisions.js';

export const ENGINE = 'ARGUS AI';
export const ATTRIBUTION_ORG = 'Intelligent Analytics';

export const ARION_AGENTS = Object.freeze({
  content: Object.freeze({
    key: 'content',
    label: 'Website content & social',
    product: 'arion',
    blurb: 'Picks what your website should be writing about, writes it in your own voice, and puts every draft in front of you before anything goes live.',
    attribution: `Created by ${ATTRIBUTION_ORG} — ARION Content & Social Agent`,
    drafts_with_ai: true,
  }),
});

/** AG-1 — the only cost words a customer ever reads. */
export const COST_NOTE = Object.freeze({
  AI: 'Written by ARGUS AI — included in your plan',
  FREE: 'No AI credits used',
});

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/* arion.content_agent_output.review_status:
     pending | approved | edited | rejected | escalated                      */
const CONTENT_STATUS = Object.freeze({
  pending: { status: 'proposed', label: 'Waiting for you' },
  escalated: { status: 'proposed', label: 'Held back — read this one carefully' },
  approved: { status: 'approved', label: 'Approved — publishing is a separate step' },
  edited: { status: 'approved', label: 'You edited it — publishing is a separate step' },
  rejected: { status: 'declined', label: 'You said no' },
});

const CONTENT_KIND = Object.freeze({
  blog_post: 'A blog post',
  social_post: 'A social post',
  social_carousel: 'A social carousel',
});

/* ── Your team: what each row says on the Needs-you card (ARGUS employees
   phase 1, CONTRACT_ARGUS_EMPLOYEES_PHASE1 §F.1). Every button calls this
   product's own route: one approval path per thing.                       */

const isSocialType = (t) => t === 'social_post' || t === 'social_carousel';
const approvedish = (st) => st === 'approved' || st === 'edited';
/** A real scheduled post id; a 'claim:' marker is a hand-off that has not come back. */
const handedOff = (row) => !!row.scheduled_social_post_id && !String(row.scheduled_social_post_id).startsWith('claim:');
/** An approved social post that did not reach the scheduler (failed, or a claim that never came back). */
const handoffStuck = (row) => !handedOff(row) && (!!row.handoff_error_plain || String(row.scheduled_social_post_id || '').startsWith('claim:'));

/** The approve route reads these body keys (routes/arion/contentAgent.js). */
const CONTENT_EDIT_FIELDS = Object.freeze({ title: 'title', body: 'body_markdown' });

/**
 * Why a PENDING draft waited, from the reason stored when it was saved (or
 * when an approval in advance failed). A row written before held_reason
 * existed falls back to its flags: quality failures say so; otherwise it was
 * the job's mode. Never "Send me first" for a draft that waited for another
 * reason.
 */
function pendingWords(row) {
  const reason = String(row.held_reason || '');
  if (reason === 'automatic_failed') return HELD_WORDS.automatic_failed;
  if (reason === 'quality') return HELD_WORDS.quality;
  if (reason === 'always_asks') return HELD_WORDS.always_asks;
  if (reason === 'send_me_first') return HELD_WORDS.send_me_first;
  const flags = parseJson(row.decision_rule_flags_json, []);
  if (Array.isArray(flags) && flags.length) return HELD_WORDS.quality;
  return HELD_WORDS.send_me_first;
}

/** Why this draft is waiting, in one sentence (null when it is not waiting). */
export function contentHeldWords(row) {
  if (row.review_status === 'escalated') return heldWordsFromFlags(parseJson(row.decision_rule_flags_json, [])) || HELD_WORDS.held_subject;
  if (row.review_status === 'pending') return pendingWords(row);
  if (approvedish(row.review_status)) {
    if (row.content_type === 'blog_post' && !row.published_at) {
      return row.approved_in_advance ? HELD_WORDS.automatic_publish_failed : HELD_WORDS.not_published;
    }
    if (isSocialType(row.content_type) && handoffStuck(row)) {
      return row.approved_in_advance ? HELD_WORDS.automatic_handoff_failed : HELD_WORDS.handoff_failed;
    }
  }
  return null;
}

/** The Needs-you buttons for one content draft (§F.1 table). */
export function contentDecide(row) {
  const id = String(row.output_id);
  const base = `/arion/content-agent/queue/${id}`;
  const social = isSocialType(row.content_type);
  const skip = { path: `${base}/reject`, reason: 'optional' };
  if (row.review_status === 'pending') {
    return social
      ? { approve: { path: `${base}/approve`, label: 'Approve and schedule', edits: ['body'], fields: CONTENT_EDIT_FIELDS, when: 'schedule' }, skip }
      : { approve: { path: `${base}/approve`, label: 'Approve', edits: ['title', 'body'], fields: CONTENT_EDIT_FIELDS }, skip };
  }
  if (row.review_status === 'escalated') {
    return {
      approve: {
        path: `${base}/approve`, label: 'Change the words, then approve',
        edits: social ? ['body'] : ['title', 'body'], fields: CONTENT_EDIT_FIELDS, edits_required: true,
        ...(social ? { when: 'schedule' } : {}),
      },
      skip,
    };
  }
  if (approvedish(row.review_status)) {
    if (row.content_type === 'blog_post' && !row.published_at) {
      return { publish: { path: `${base}/publish`, label: 'Put it on your website' } };
    }
    if (social && handoffStuck(row)) {
      return { approve: { path: `${base}/schedule`, label: 'Try again', edits: [] } };
    }
  }
  return {};
}

/** A row a person can act on from Needs you: it has at least one button. */
export function isWaiting(row) {
  return !!(row.decide && (row.decide.approve || row.decide.skip || row.decide.publish));
}

export function normaliseContentRow(row) {
  const map = CONTENT_STATUS[row.review_status] || { status: 'proposed', label: row.review_status };
  const what = CONTENT_KIND[row.content_type] || 'A piece of content';
  const flags = parseJson(row.decision_rule_flags_json, []);
  const published = !!row.published_at;
  return {
    agent: 'content',
    agent_label: ARION_AGENTS.content.label,
    product: 'arion',
    kind: 'proposal',
    id: String(row.output_id),
    summary: `${what}${row.primary_keyword ? ` about “${clip(row.primary_keyword, 50)}”` : ''}${row.title ? ` — ${clip(row.title, 70)}` : ''}`,
    detail: {
      subject: row.title || null,
      // The EDITED version is what will publish, so it is what the card shows;
      // the agent's original stays available beside it for comparison.
      body: row.body_markdown_final || row.body_markdown || null,
      agent_original: row.body_markdown_final ? row.body_markdown : null,
      why: row.keyword_rationale || null,
      evidence: row.primary_keyword
        ? `Keyword “${row.primary_keyword}”${row.keyword_volume != null ? `, about ${row.keyword_volume} searches a month` : ''}${row.keyword_kd != null ? `, difficulty ${row.keyword_kd}` : ''}${row.keyword_intent ? `, ${row.keyword_intent} intent` : ''}.`
        : null,
      confidence_note: row.confidence_note || null,
      grounded_on: flags,
      // A carousel arrives as words with a render-by-hand flag until the picture
      // store exists. Saying so beats a silently missing image.
      needs_manual_render: row.content_type === 'social_carousel' && !row.asset_uri,
      url_slug: row.url_slug || null,
      published_at: iso(row.published_at),
      wordpress_post_id: row.wordpress_post_id == null ? null : Number(row.wordpress_post_id),
    },
    status: map.status,
    status_label: published ? 'Live on your website' : map.label,
    hold_note: row.review_status === 'escalated'
      ? 'This draft crossed one of the lines we hold back for a person to check, so it is not approvable from here.'
      : (row.review_status === 'approved' || row.review_status === 'edited') && !published
        ? 'Approved and waiting. Publishing it to your website is a separate button.'
        : null,
    proposed_at: iso(row.created_at),
    decided_at: iso(row.approved_at),
    cost_units: null,
    cost_note: COST_NOTE.AI,
    // AC2/AC8: only a genuinely pending unit is decidable here. An escalated one
    // is visible and refused, which is the whole point of escalating it.
    can_decide: row.review_status === 'pending',
    // The extra verb this agent has that the others do not.
    can_publish: (row.review_status === 'approved' || row.review_status === 'edited') && !published,
    attribution: ARION_AGENTS.content.attribution,
    links: row.published_at && row.url_slug
      ? [{ label: 'See it on your website', href: `/${String(row.url_slug).replace(/^\/+/, '')}` }]
      : [],
    job_key: row.job_key || jobForContentType(row.content_type),
    employee_key: EMPLOYEE_KEY,
    brief_cited: parseJson(row.brief_cited_json, null),
    held_words: contentHeldWords(row),
    decide: contentDecide(row),
    approved_in_advance: !!row.approved_in_advance,
  };
}

/* ── Google review replies (arion.gbp_reply_draft) ─────────────────────
   status: held | posted | skipped | stood_down | failed                    */

export const REVIEW_REPLY_AGENT = Object.freeze({
  key: 'review_replies',
  label: 'Google review replies',
  product: 'arion',
  attribution: ARION_AGENTS.content.attribution,
});

const REPLY_STATUS = Object.freeze({
  held: { status: 'proposed', label: 'Waiting for you' },
  failed: { status: 'proposed', label: "Google didn't take it — waiting for you" },
  posting: { status: 'proposed', label: 'Posting on Google' },
  posted: { status: 'approved', label: 'Posted on Google' },
  skipped: { status: 'declined', label: 'You skipped it' },
  stood_down: { status: 'stopped', label: 'Someone already answered it on Google' },
});

/** A reply a person can decide: held, failed, or a post that never came back. */
const replyWaiting = (row) => row.status === 'held' || row.status === 'failed'
  || (row.status === 'posting' && Number(row.posting_stale) === 1);

/** Why a reply is waiting, in one sentence. */
function replyHeldWords(row) {
  if (row.status === 'failed') return HELD_WORDS.post_failed;
  if (row.status === 'posting') return HELD_WORDS.posting_unconfirmed;
  return row.held_words || HELD_WORDS.send_me_first;
}

export function replyDecide(row) {
  const id = String(row.draft_id);
  if (!replyWaiting(row)) return {};
  return {
    approve: {
      path: `/arion/review-replies/${id}/approve`,
      label: row.status === 'held' ? 'Post this reply' : 'Try again',
      edits: ['body'], fields: { body: 'body' },
    },
    skip: { path: `/arion/review-replies/${id}/skip`, reason: 'optional' },
  };
}

export function normaliseReviewReplyRow(row) {
  const map = REPLY_STATUS[row.status] || { status: 'proposed', label: row.status };
  const stars = Number(row.star_rating);
  const who = row.reviewer_name ? ` from ${clip(row.reviewer_name, 40)}` : '';
  const waiting = replyWaiting(row);
  return {
    agent: REVIEW_REPLY_AGENT.key,
    agent_label: REVIEW_REPLY_AGENT.label,
    product: 'arion',
    kind: 'proposal',
    id: String(row.draft_id),
    summary: `Reply to a ${Number.isFinite(stars) ? stars : '?'}-star review${who}`,
    detail: {
      subject: null,
      body: row.reply_final || row.reply_text || null,
      review: row.review_text || null,
      stars: Number.isFinite(stars) ? stars : null,
      reviewer: row.reviewer_name || null,
      post_error: row.post_error_plain || null,
      skip_reason: row.skip_reason || null,
    },
    status: map.status,
    status_label: map.label,
    hold_note: waiting ? replyHeldWords(row) : null,
    proposed_at: iso(row.created_at),
    decided_at: iso(row.decided_at),
    decided_by: row.decided_by || null,
    cost_units: null,
    cost_note: COST_NOTE.AI,
    can_decide: waiting,
    attribution: REVIEW_REPLY_AGENT.attribution,
    links: [],
    job_key: JOB.REVIEWS,
    employee_key: EMPLOYEE_KEY,
    brief_cited: parseJson(row.brief_cited_json, null),
    held_words: waiting ? replyHeldWords(row) : null,
    decide: replyDecide(row),
  };
}

export function sortActivity(rows) {
  return [...rows].sort((a, b) => {
    const ta = a.proposed_at ? Date.parse(a.proposed_at) : 0;
    const tb = b.proposed_at ? Date.parse(b.proposed_at) : 0;
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Does this table exist here? A missing one degrades, never 500s. */
export async function tableExists(pool, fq) {
  const r = await pool.request()
    .input('n', sql.NVarChar(200), fq)
    .query("SELECT OBJECT_ID(@n, 'U') AS id");
  return r.recordset?.[0]?.id != null;
}

const CONTENT_COLS = `output_id, run_id, content_type, primary_keyword, keyword_volume,
  keyword_kd, keyword_intent, keyword_rationale, title, body_markdown,
  body_markdown_final, meta_description, url_slug, asset_uri,
  decision_rule_flags_json, confidence_note, review_status, review_note,
  approved_at, published_at, wordpress_post_id, created_at,
  job_key, brief_cited_json, approved_in_advance, scheduled_social_post_id, handoff_error_plain, held_reason`;

/** "Somebody can act on it": pending, escalated, approved-not-published, a failed hand-off. */
const CONTENT_WAITING_SQL = `(review_status IN ('pending','escalated')
   OR (review_status IN ('approved','edited') AND content_type = 'blog_post' AND published_at IS NULL)
   OR (review_status IN ('approved','edited') AND content_type IN ('social_post','social_carousel')
       AND ((scheduled_social_post_id IS NULL AND handoff_error_plain IS NOT NULL)
            OR scheduled_social_post_id LIKE 'claim:%')))`;

export async function fetchContent(pool, tenantId, { limit = 50, waiting = false } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) ${CONTENT_COLS}
              FROM arion.content_agent_output
             WHERE tenant_id = @tenantId${waiting ? ` AND ${CONTENT_WAITING_SQL}` : ''}
             ORDER BY created_at DESC`);
  return r.recordset.map(normaliseContentRow);
}

/** A 'posting' claim older than this never came back (lib/gbpReplyRunner.js POSTING_STALE_MINUTES). */
const POSTING_STALE_SQL = "status = 'posting' AND decided_at < DATEADD(MINUTE, -2, SYSDATETIMEOFFSET())";

const REPLY_COLS = `draft_id, run_id, site_id, gbp_review_id, reviewer_name, star_rating, review_text,
  reply_text, reply_final, status, held_reason, held_words, brief_cited_json, decided_by,
  decided_at, skip_reason, post_error_plain, created_at,
  CASE WHEN ${POSTING_STALE_SQL} THEN 1 ELSE 0 END AS posting_stale`;

export async function fetchReviewReplies(pool, tenantId, { limit = 50, waiting = false } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) ${REPLY_COLS}
              FROM arion.gbp_reply_draft
             WHERE tenant_id = @tenantId${waiting ? ` AND (status IN ('held','failed') OR (${POSTING_STALE_SQL}))` : ''}
             ORDER BY created_at DESC`);
  return r.recordset.map(normaliseReviewReplyRow);
}

/**
 * Every ARION agent's activity for one Business.
 *
 * `escalated` is returned as its OWN collection as well as inside `rows`, so a
 * page can put held drafts visibly apart without re-deriving which ones they are
 * — the same both-ways shape the queue endpoint uses for the same reason.
 */
export async function loadArionActivity(pool, tenantId, { limit = 50, waiting = false } = {}) {
  const degraded = [];
  const rows = [];
  const sources = [
    { agent: 'content', table: 'arion.content_agent_output', run: () => fetchContent(pool, tenantId, { limit, waiting }) },
    { agent: REVIEW_REPLY_AGENT.key, table: 'arion.gbp_reply_draft', run: () => fetchReviewReplies(pool, tenantId, { limit, waiting }) },
  ];
  for (const src of sources) {
    try {
      if (!(await tableExists(pool, src.table))) {
        degraded.push({ agent: src.agent, error: `${src.table} is not in this database yet` });
      } else {
        rows.push(...(await src.run()));
      }
    } catch (err) {
      degraded.push({ agent: src.agent, error: err.message });
    }
  }

  // ?waiting=1 — Needs you: only rows with a button on them.
  const sorted = sortActivity(waiting ? rows.filter(isWaiting) : rows);
  return {
    rows: sorted.filter((r) => r.status_label !== CONTENT_STATUS.escalated.label),
    escalated: sorted.filter((r) => r.status_label === CONTENT_STATUS.escalated.label),
    meta: {
      engine: ENGINE,
      total: sorted.length,
      waiting: sorted.filter((r) => r.status === 'proposed').length,
      approved_awaiting_publish: sorted.filter((r) => r.can_publish).length,
      degraded,
    },
  };
}

export default {
  ENGINE, ARION_AGENTS, COST_NOTE, CONTENT_STATUS, REVIEW_REPLY_AGENT,
  normaliseContentRow, normaliseReviewReplyRow, contentHeldWords, contentDecide, replyDecide, isWaiting,
  sortActivity, fetchContent, fetchReviewReplies, loadArionActivity, tableExists,
};
