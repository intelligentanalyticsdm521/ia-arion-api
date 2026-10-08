// lib/contentAgent/decisions.js — the ONE writer of a content draft's decision.
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.3, §G.7). The
// review route (routes/arion/contentAgent.js) and the Automatic path in the
// runner both approve through approveOutput, so a draft approved by a person
// and a draft approved in advance cannot be written two different ways.
//
// THE STATUS MOVE IS GUARDED (finding F2). The UPDATE carries
// `AND review_status = @expected` (the status that was read) and must move
// exactly one row; two approvals racing each other cannot both win.
//
// ESCALATED IS NEVER APPROVED AS WRITTEN (AC2). Approving an escalated draft
// needs edits, and the edited text runs every check again; a check that fires
// refuses with its sentence. The Automatic path never approves an escalated
// draft at all.
//
// AN APPROVAL IN ADVANCE TEACHES NOTHING (§G.7). recordSignal is a person's
// reading of a draft; a standing approval read nothing. So `inAdvance` writes
// approved_in_advance = 1 and records no signal.

import sql from 'mssql';
import { recordSignal, SIGNAL_KIND } from './styleProfile.js';
import { publishApproved, PublishRefused } from './publisher.js';
import { checkEscalation } from './guardrails.js';
import { runChecks, PLATFORM_CHECKS, HELD_WORDS, jobForContentType } from '../jobChecks.js';

/** Record why a pending draft waits (see migration 071 held_reason). */
export async function markHeldReason(pool, { tenantId, outputId, reason }) {
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('reason', sql.NVarChar(40), reason)
    .query(`UPDATE arion.content_agent_output SET held_reason = @reason
             WHERE tenant_id = @tenantId AND output_id = @id AND review_status = 'pending'`);
}

/**
 * The checks an edited draft runs again: the job's platform checks PLUS the
 * ones its pinned job description added when it was written (stored on the
 * row as checks_json). A row from before checks_json reads the platform list.
 */
export function checksToRerun(jobKey, storedJson) {
  let stored = [];
  try { const v = JSON.parse(storedJson || 'null'); if (Array.isArray(v)) stored = v.map(String); } catch { stored = []; }
  return [...new Set([...(PLATFORM_CHECKS[jobKey] || []), ...stored])];
}

/** A refusal with an HTTP status and a sentence an owner can read. */
export class DecisionRefused extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DecisionRefused';
    this.status = status;
    this.code = code;
  }
}

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/** The held sentence for an escalated draft, from its stored flags. */
export function heldWordsFromFlags(flags) {
  const list = Array.isArray(flags) ? flags : [];
  for (const f of list) {
    const rule = String(f?.rule || '');
    if (rule.startsWith('check:')) return HELD_WORDS[rule.slice(6)] || HELD_WORDS.held_subject;
    if (rule === 'real_client_named_without_approval') return HELD_WORDS.no_names_from_never_name;
    if (rule === 'competitor_named_critically') return HELD_WORDS.no_competitor_names;
  }
  return list.length ? HELD_WORDS.held_subject : null;
}

/**
 * Every check this draft's job runs, plus the content agent's own escalation
 * rules, on `text`. Returns the first sentence that fires, or null.
 */
export function recheck(text, { jobKey, checkCtx, names = PLATFORM_CHECKS[jobKey] || [] }) {
  const named = runChecks(text, names, checkCtx);
  if (!named.ok) return `ARGUS has no check called ${named.unknown[0]}, so I did nothing.`;
  if (named.fired.length) return named.fired[0].words;
  const esc = checkEscalation(text, {
    protectedClientNames: checkCtx.namesNeverMention || [],
    approvedClientNames: checkCtx.namesYouMayMention || [],
    competitorNames: checkCtx.competitors || [],
    shippedFeatures: checkCtx.shippedFeatures || [],
  });
  if (esc.escalate) return heldWordsFromFlags(esc.flags);
  return null;
}

async function readRow(pool, tenantId, outputId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .query(`
      SELECT output_id, content_type, job_key, title, body_markdown, meta_description,
             review_status, decision_rule_flags_json, checks_json
        FROM arion.content_agent_output
       WHERE tenant_id = @tenantId AND output_id = @id`);
  return r.recordset[0] || null;
}

/**
 * Approve one draft.
 *
 * @param {object} p
 * @param {object} p.edits      { title?, body_markdown?, meta_description? }
 * @param {string} p.actor      the person, or "Approved in advance by …"
 * @param {boolean} p.inAdvance true only on the Automatic path
 * @param {Function} p.loadCheckCtx  async () => the Brief's check lists; only
 *        called when an escalated draft is approved with edits
 * @returns {Promise<{ output_id, review_status, content_type, job_key, was_edited }>}
 * @throws {DecisionRefused}
 */
export async function approveOutput(pool, {
  tenantId, outputId, edits = {}, note = null, actor = null, inAdvance = false,
  loadCheckCtx = null, signal = recordSignal,
}) {
  const row = await readRow(pool, tenantId, outputId);
  if (!row) throw new DecisionRefused(404, 'NOT_FOUND', "That draft isn't waiting for you any more.");
  const expected = row.review_status;
  if (expected !== 'pending' && expected !== 'escalated') {
    throw new DecisionRefused(409, 'ALREADY_REVIEWED', `That draft was already decided (${expected}).`);
  }

  const changed = (a, b) => b != null && String(a || '').trim() !== String(b).trim();
  const bodyChanged = changed(row.body_markdown, edits.body_markdown);
  const titleChanged = changed(row.title, edits.title);
  const metaChanged = changed(row.meta_description, edits.meta_description);
  const wasEdited = bodyChanged || titleChanged || metaChanged;
  const finalBody = edits.body_markdown ?? row.body_markdown;
  const finalTitle = edits.title ?? row.title;
  const finalMeta = edits.meta_description ?? row.meta_description;

  if (expected === 'escalated') {
    const held = heldWordsFromFlags(parseJson(row.decision_rule_flags_json, [])) || HELD_WORDS.held_subject;
    if (inAdvance) throw new DecisionRefused(409, 'ESCALATED', `This one waits for you: ${held}`);
    if (!wasEdited) throw new DecisionRefused(409, 'ESCALATED', `Change the words first: ${held}`);
    if (typeof loadCheckCtx !== 'function') {
      throw new DecisionRefused(503, 'CHECKS_UNAVAILABLE', "I couldn't check your changes just now, so nothing was approved. Try again in a minute.");
    }
    const checkCtx = await loadCheckCtx();
    if (!checkCtx) {
      throw new DecisionRefused(503, 'BRIEF_UNREADABLE', "I couldn't read your business details to check your changes, so nothing was approved. Try again in a minute.");
    }
    const jobKey = row.job_key || jobForContentType(row.content_type);
    const fired = recheck(`${finalTitle || ''}\n${finalMeta || ''}\n${finalBody || ''}`, {
      jobKey, checkCtx, names: checksToRerun(jobKey, row.checks_json),
    });
    if (fired) throw new DecisionRefused(409, 'CHECK_FIRED', fired);
  }

  const status = wasEdited ? 'edited' : 'approved';
  const upd = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('expected', sql.NVarChar(20), expected)
    .input('finalBody', sql.NVarChar(sql.MAX), finalBody)
    .input('title', sql.NVarChar(500), finalTitle)
    .input('meta', sql.NVarChar(500), finalMeta)
    .input('status', sql.NVarChar(20), status)
    .input('note', sql.NVarChar(sql.MAX), note)
    .input('by', sql.NVarChar(256), actor)
    .input('inAdvance', sql.Bit, inAdvance ? 1 : 0)
    .query(`
      UPDATE arion.content_agent_output
         SET body_markdown_final = @finalBody, title = @title, meta_description = @meta,
             review_status = @status, review_note = @note, reviewed_by = @by,
             approved_at = SYSDATETIMEOFFSET(), approved_in_advance = @inAdvance
       WHERE tenant_id = @tenantId AND output_id = @id AND review_status = @expected;
      SELECT @@ROWCOUNT AS affected;`);
  if (Number(upd.recordset?.[0]?.affected) !== 1) {
    throw new DecisionRefused(409, 'RACE', 'That draft was decided somewhere else just now, so nothing changed.');
  }

  // The learning loop: a person's reading only. An approval in advance read nothing.
  if (!inAdvance) {
    if (wasEdited) {
      const fields = [
        ['body', row.body_markdown, edits.body_markdown, bodyChanged],
        ['title', row.title, edits.title, titleChanged],
        ['meta_description', row.meta_description, edits.meta_description, metaChanged],
      ];
      for (const [name, before, after, didChange] of fields) {
        if (!didChange) continue;
        await signal(pool, {
          tenantId, outputId, signalKind: SIGNAL_KIND.EDITED, fieldName: name,
          beforeText: before, afterText: after, reviewerNote: note,
        });
      }
    } else {
      await signal(pool, { tenantId, outputId, signalKind: SIGNAL_KIND.APPROVED_AS_IS, reviewerNote: note });
    }
  }

  return {
    output_id: outputId, review_status: status, content_type: row.content_type,
    job_key: row.job_key || jobForContentType(row.content_type), was_edited: wasEdited,
  };
}

/** Skip (reject) one draft. The reason is optional; the signal is recorded either way. */
export async function rejectOutput(pool, { tenantId, outputId, reason = null, actor = null, signal = recordSignal }) {
  const why = reason && String(reason).trim() ? String(reason).trim() : null;
  const upd = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('reason', sql.NVarChar(sql.MAX), why)
    .input('by', sql.NVarChar(256), actor)
    .query(`
      UPDATE arion.content_agent_output
         SET review_status = 'rejected', review_note = @reason,
             reviewed_by = @by, approved_at = NULL
       WHERE tenant_id = @tenantId AND output_id = @id
         AND review_status IN ('pending','escalated');
      SELECT @@ROWCOUNT AS affected;`);
  if (Number(upd.recordset?.[0]?.affected) !== 1) {
    throw new DecisionRefused(404, 'NOT_FOUND', "That draft isn't waiting for you any more.");
  }
  await signal(pool, { tenantId, outputId, signalKind: SIGNAL_KIND.REJECTED, reviewerNote: why });
  return { output_id: outputId, review_status: 'rejected' };
}

/**
 * Put an approved blog post on the website. Never reports success it did not
 * have: a refusal throws PublishRefused; a website failure returns ok:false
 * with the alert, and the row stays approved-not-published (F5).
 */
export async function publishOutput(pool, { tenantId, outputId, status = 'publish', publishAt = null, publish = publishApproved }) {
  return publish({ pool, tenantId, outputId, status, publishAt });
}

export { PublishRefused };
export default { DecisionRefused, heldWordsFromFlags, recheck, checksToRerun, markHeldReason, approveOutput, rejectOutput, publishOutput };
