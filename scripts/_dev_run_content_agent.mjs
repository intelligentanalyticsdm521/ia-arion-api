// scripts/_dev_run_content_agent.mjs
//
// Runs the ARION Content & Social Agent ONCE against the ARGUS POC fixture
// business, with a provider stand-in, and prints one JSON line on stdout for the
// orchestrator in oliver-api.
//
//   node scripts/_dev_run_content_agent.mjs
//
// It drives the WHOLE tick, not just the runner: the style-profile compilation
// step (ARGUS pack 1), the keyword-tracker writes, topic selection with no SEO
// tool configured, drafting through the metered wrapper, the guardrails, the
// suite ceiling, the 60% margin report and the alert dispatch. Everything except
// the model call and the outbound email is real.
//
// LOCAL ONLY, and no key: the stand-in replaces the provider so the run costs
// nothing and reaches nobody.

import 'dotenv/config';
import { getServicesPool } from '../db/servicesPool.js';
import { runTick } from '../lib/contentAgent/tick.js';

const POC_TENANT = '1a1a1a1a-0000-4000-8000-00000001a1a1';

const server = String(process.env.SQL_SERVER || '');
if (!/^(localhost|127\.0\.0\.1|\.|\(local\))/i.test(server)) {
  console.error(JSON.stringify({ error: `REFUSING: SQL_SERVER "${server}" is not local` }));
  process.exit(1);
}

/**
 * The stand-in.
 *
 * Two things it has to get right, and both are contracts the real provider is
 * held to as well:
 *
 *   1. meterAndAudit's runCall shape: { inputTokens, outputTokens, imageCount,
 *      data: { text } }. Returning the text at the top level parses as
 *      `unparseable_output` — which is also what a real provider change would
 *      look like, so it is worth being strict about.
 *
 *   2. KEYWORD PLACEMENT. `checkKeywordPlacement` requires the chosen keyword in
 *      the title, the first 100 words, a subheading AND the meta description
 *      (SEO Standards 3.2). A stand-in that ignores it is skipped as F4 —
 *      correctly — and the exercise then proves the validator rather than the
 *      agent. So the stand-in reads the keyword out of the user turn, the same
 *      instruction the real model gets, and places it properly.
 *
 * The copy is deliberately dull and specific: no superlative, no invented offer,
 * no client name, no claim we could not measure. A stand-in that tripped the
 * guardrails would prove the guardrails and prove nothing about the agent.
 */
function contentStandIn({ userTurn = '' } = {}) {
  const m = /PRIMARY KEYWORD:\s*(.+)/i.exec(String(userTurn));
  const kw = (m ? m[1] : 'website audit').trim();
  const Kw = kw.charAt(0).toUpperCase() + kw.slice(1);

  const body = [
    `## Start with what is measurable about ${kw}`,
    '',
    `A ${kw} reads what a crawler can reach. It records how long a page takes to respond,`,
    'whether the headings are in order, whether an image has alternative text, and whether a',
    'link goes anywhere. Those are facts, and they are the useful part.',
    '',
    '## What it cannot see',
    '',
    'It cannot tell you whether the writing is any good, and it cannot tell you whether the',
    'people who visit found what they came for. A clean report and an unhelpful website are a',
    'common pairing.',
    '',
    '## How to read the result',
    '',
    'Take the items in order of how many pages they affect. One broken link on one page is a',
    'chore; a missing heading structure across forty pages is a pattern. Fix patterns first.',
    '',
    '## What we do with it',
    '',
    'We keep the list, work down it, and tell you what changed. Nothing on the list is urgent',
    'by itself; the list stops being useful the week nobody reads it.',
    '',
  ].join('\n');

  const text = JSON.stringify({
    title: `${Kw}: what it actually tells you`,
    meta_description: `A plain account of ${kw}: what it measures, what it cannot see, and how to read the result.`,
    url_slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
    body_markdown: body,
    cover_image_prompt: 'A plain desk with a printed checklist and a pencil, soft daylight.',
    confidence_note: 'Written from the declared brand voice. No learned style profile was in use.',
  });
  return { inputTokens: 9200, outputTokens: 3100, imageCount: 0, data: { text, cacheReadTokens: 0 } };
}

const pool = await getServicesPool();
const logLines = [];
let summary = null;
let error = null;

try {
  summary = await runTick({
    pool,
    log: (m) => logLines.push(String(m)),
    tenantFilter: POC_TENANT,
    callImpl: contentStandIn,
    // No email leaves a dev exercise. The gate and the identity resolver are the
    // parts worth exercising; the SMTP hop is not, and a dev box has no sender.
    notify: async ({ alerts }) => alerts.map((a) => ({ tenantId: a.tenantId, outcome: 'suppressed_dev_exercise' })),
  });
} catch (err) {
  error = err.message;
}

// ── PHASE 2: does it actually LEARN? ─────────────────────────────────────
// The compile step reads `arion.content_agent_style_signal`, which is written by
// the approve and reject routes. On a first cycle there is nothing to read, so
// the honest answer above is `no_new_evidence` — and "it has nothing to learn
// from yet" and "learning is not wired" look identical from there.
//
// So this phase does what a human does: takes the draft the agent just made,
// approves it WITH AN EDIT (which is the highest-signal evidence the whole system
// has), and compiles. If a profile version comes back, the loop is real.
let learnedAfterEdit = null;
try {
  const { recordSignal, SIGNAL_KIND } = await import('../lib/contentAgent/styleProfile.js');
  const { compileStyleProfile } = await import('../lib/contentAgent/styleCompile.js');

  const pending = await pool.request()
    .input('t', POC_TENANT)
    .query(`SELECT TOP 1 output_id, title, body_markdown FROM arion.content_agent_output
             WHERE tenant_id = @t AND review_status = 'pending' ORDER BY created_at DESC`);
  const row = pending.recordset[0];
  if (row) {
    // A real edit: shorter, plainer, one fewer adjective. Exactly the kind of
    // change the profile is supposed to notice.
    const edited = String(row.body_markdown).replace(/, and they are the useful part\./, '.');
    await pool.request()
      .input('t', POC_TENANT)
      .input('id', row.output_id)
      .input('final', edited)
      .query(`UPDATE arion.content_agent_output
                 SET review_status = 'edited', body_markdown_final = @final,
                     approved_at = SYSDATETIMEOFFSET(), reviewed_by = 'dev exercise'
               WHERE tenant_id = @t AND output_id = @id`);
    await recordSignal(pool, {
      tenantId: POC_TENANT, outputId: row.output_id, signalKind: SIGNAL_KIND.EDITED,
      fieldName: 'body', beforeText: row.body_markdown, afterText: edited,
      reviewerNote: 'Trimmed a clause. Dev exercise.',
    });
    learnedAfterEdit = await compileStyleProfile({
      pool, tenantId: POC_TENANT, deps: { log: (m) => logLines.push(m) },
    });
  } else {
    learnedAfterEdit = { outcome: 'no_draft_to_edit' };
  }
} catch (err) {
  learnedAfterEdit = { outcome: 'failed', reason: err.message };
}

const drafted = summary ? (summary.results || []).reduce((n, r) => n + (r.drafted || 0), 0) : 0;
const cost = summary ? (summary.results || []).reduce((n, r) => n + (r.costUsd || 0), 0) : 0;

// What the LEARNING step said, because "it learned nothing new" and "the learning
// step broke" are different facts and this is the pack's headline capability.
const learned = summary && summary.learned && summary.learned[0] ? summary.learned[0] : null;

// Did the keyword tracker actually get written? Nothing wrote it before this pack,
// so a zero here means the fix did not land.
let keywords = 0;
try {
  const r = await pool.request()
    .query(`SELECT COUNT(*) n FROM arion.content_keyword_candidate WHERE tenant_id = '${POC_TENANT}'`);
  keywords = Number(r.recordset[0].n);
} catch { keywords = -1; }

console.log(JSON.stringify({
  content: {
    agent: 'ARION website content & social',
    ran: !!summary && !summary.disabled,
    status: error ? 'error' : (summary && summary.failed ? 'failed' : 'completed'),
    outcome: error || (summary ? ((summary.results[0] && summary.results[0].outcome) || 'ran') : 'not run'),
    proposals: drafted,
    cost_usd: Number(cost.toFixed(6)),
    alerts: summary ? (summary.alerts || []).map((a) => `${a.failure_mode}:${a.code}`) : ['error'],
    learned: learned
      ? { outcome: learned.outcome, version: learned.version || null, signals: learned.signals, in_use: learned.inUse ?? null }
      : null,
    // The loop, proven: one human edit in, one profile version out.
    learned_after_one_edit: learnedAfterEdit
      ? {
        outcome: learnedAfterEdit.outcome,
        version: learnedAfterEdit.version || null,
        signals: learnedAfterEdit.signals ?? null,
        evidence: learnedAfterEdit.evidenceCount ?? null,
        exemplars: learnedAfterEdit.exemplars ?? null,
        in_use: learnedAfterEdit.inUse ?? null,
        reason: learnedAfterEdit.reason || null,
      }
      : null,
    keywords_tracked: keywords,
    margins: summary ? (summary.margins || []).map((m) => `${m.verdict}`) : [],
    log: logLines,
  },
}));
process.exit(0);
