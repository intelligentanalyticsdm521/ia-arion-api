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
  approved_at, published_at, wordpress_post_id, created_at`;

export async function fetchContent(pool, tenantId, { limit = 50 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) ${CONTENT_COLS}
              FROM arion.content_agent_output
             WHERE tenant_id = @tenantId
             ORDER BY created_at DESC`);
  return r.recordset.map(normaliseContentRow);
}

/**
 * Every ARION agent's activity for one Business.
 *
 * `escalated` is returned as its OWN collection as well as inside `rows`, so a
 * page can put held drafts visibly apart without re-deriving which ones they are
 * — the same both-ways shape the queue endpoint uses for the same reason.
 */
export async function loadArionActivity(pool, tenantId, { limit = 50 } = {}) {
  const degraded = [];
  let rows = [];
  try {
    if (!(await tableExists(pool, 'arion.content_agent_output'))) {
      degraded.push({ agent: 'content', error: 'arion.content_agent_output is not in this database yet' });
    } else {
      rows = await fetchContent(pool, tenantId, { limit });
    }
  } catch (err) {
    degraded.push({ agent: 'content', error: err.message });
  }

  const sorted = sortActivity(rows);
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
  ENGINE, ARION_AGENTS, COST_NOTE, CONTENT_STATUS,
  normaliseContentRow, sortActivity, fetchContent, loadArionActivity, tableExists,
};
