// lib/agents/runs.js — "What it has been doing" for the ARION content agent.
//
// The run side. The same file exists in oliver-api (lib/agents/runs.js) and LUMEN
// (src/lib/agentActivity/sparkRuns.js) and keeps the same rules, because one
// Portal component renders all three:
//
//   AG-1  no cost_usd on a client endpoint, at all
//   AG-2  plain words for what a run MEANT, not the raw status
//   F1    a missing table is reported in meta.degraded, never a 500
//
// This agent's runs have one thing the others' do not: a KEYWORD. "It looked and
// there was nothing to do" is a very different fact from "it looked, found four
// candidates and rejected all of them for being too competitive for a website
// this young", and the second is the sentence that makes the agent trustworthy.

import sql from 'mssql';
import { ARION_AGENTS, COST_NOTE, tableExists, REVIEW_REPLY_AGENT, DEGRADED_WORDS } from './activity.js';
import { JOB } from '../jobChecks.js';

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export const TRIGGER_WORDS = Object.freeze({
  timer: 'On its weekly schedule',
  manual: 'You ran it',
  backfill: 'Catching up',
});

/** Rules whose own sentence IS the run's story (ARGUS employees phase 1). */
const SENTENCE_RULES = new Set(['waiting_for_brief', 'brief_unreadable', 'steps_mismatch', 'unknown_check']);

export function outcomeWords({ status, drafted, flags }) {
  const list = Array.isArray(flags) ? flags : [];
  const rules = new Set(list.map((f) => f?.rule).filter(Boolean));
  const said = list.find((f) => SENTENCE_RULES.has(f?.rule) && f?.detail);
  if (said?.rule === 'waiting_for_brief') return { outcome: 'blocked', label: said.detail };
  if (said) return { outcome: 'failed', label: said.detail };
  if (status === 'failed') return { outcome: 'failed', label: 'It could not finish' };
  if (status === 'escalated') return { outcome: 'escalated', label: 'It held something back for you to read' };
  if (rules.has('suite_ceiling_breached')) return { outcome: 'halted', label: 'It stopped — the spending limit for this business was reached' };
  if (status === 'running' || status === 'pending') return { outcome: 'running', label: 'Running now' };
  if (Number(drafted) > 0) return { outcome: 'worked', label: `Wrote ${drafted} ${drafted === 1 ? 'piece' : 'pieces'} for you` };
  if (rules.has('no_qualifying_topic')) return { outcome: 'nothing_due', label: 'Nothing it looked at was worth writing about yet' };
  return { outcome: 'nothing_due', label: 'It looked and there was nothing to do' };
}

export const FLAG_WORDS = Object.freeze({
  no_qualifying_topic: 'Every topic it considered was too competitive or already covered.',
  slot_skipped: 'One piece could not be written this time.',
  render_failed: 'The pictures for a carousel could not be made, so the words are there and the slides need doing by hand.',
  governance_rules_unavailable: 'Your own extra rules could not be read, so only the built-in checks ran.',
  suite_ceiling_warn: 'Spending for this business is getting close to its limit.',
  suite_ceiling_breached: 'Spending for this business reached its limit, so it stopped.',
  suite_ceiling_ceiling_unreadable: 'The spending limit could not be checked this time.',
  suite_ceiling_no_ceiling_configured: 'No spending limit is set for this business.',
  suite_ceiling_not_enforced: 'A spending limit exists but is switched off.',
  style_profile_compiled: 'It folded your recent edits into what it has learned about your voice.',
  approved_in_advance: 'It sent what it wrote without waiting, as you set the job to do.',
  automatic_publish_failed: "Something it approved in advance didn't reach your website, so it's waiting for you.",
  automatic_handoff_failed: "A social post it approved in advance didn't reach your scheduler, so it's waiting for you.",
  automatic_failed: "An approval in advance didn't go through, so the draft is waiting for you.",
});

export function flagSentence(flag) {
  const known = FLAG_WORDS[flag?.rule];
  if (known) return known;
  return flag?.detail ? String(flag.detail) : String(flag?.rule || 'Something was skipped.');
}

export function normaliseRunRow(row) {
  const flags = parseJson(row.decision_rule_flags_json, []);
  const drafted = row.drafted != null ? Number(row.drafted) : null;
  const o = outcomeWords({ status: row.status, drafted, flags });
  return {
    agent: 'content',
    agent_label: ARION_AGENTS.content.label,
    product: 'arion',
    job_key: row.job_key || null,
    playbook_version: row.playbook_version == null ? null : Number(row.playbook_version),
    run_id: String(row.run_id),
    started_at: iso(row.triggered_at),
    finished_at: iso(row.completed_at),
    trigger: row.trigger_source || null,
    trigger_label: TRIGGER_WORDS[row.trigger_source] || 'Started by hand',
    status: row.status,
    outcome: o.outcome,
    outcome_label: o.label,
    drafted,
    keywords: row.keywords ? String(row.keywords).split('|').filter(Boolean) : [],
    cost_note: COST_NOTE.AI,
    notes: (Array.isArray(flags) ? flags : []).map(flagSentence),
    failure: row.status === 'failed'
      ? { reason: String(row.error_detail || 'It stopped part-way through.').split('\n')[0].slice(0, 300) }
      : null,
  };
}

export async function fetchContentRuns(pool, tenantId, { limit = 20 } = {}) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) r.run_id, r.trigger_source, r.status, r.triggered_at,
             r.completed_at, r.decision_rule_flags_json, r.error_detail, r.job_key, r.playbook_version,
             (SELECT COUNT(*) FROM arion.content_agent_output o WHERE o.run_id = r.run_id) AS drafted,
             STUFF((SELECT '|' + o2.primary_keyword
                      FROM arion.content_agent_output o2
                     WHERE o2.run_id = r.run_id AND o2.primary_keyword IS NOT NULL
                     FOR XML PATH('')), 1, 1, '') AS keywords
        FROM arion.content_agent_run_log r
       WHERE r.tenant_id = @t
       ORDER BY r.triggered_at DESC`);
  return r.recordset.map(normaliseRunRow);
}

/* ── Google review replies (arion.gbp_reply_run) ─────────────────────── */

const REPLY_OUTCOME = Object.freeze({
  worked: (r) => {
    const posted = Number(r.posted || 0);
    const held = Number(r.held || 0);
    const bits = [];
    if (posted) bits.push(`posted ${posted} ${posted === 1 ? 'reply' : 'replies'}`);
    if (held) bits.push(`${held} ${held === 1 ? 'is' : 'are'} waiting for you`);
    return `Wrote ${Number(r.drafted || 0)} ${Number(r.drafted) === 1 ? 'reply' : 'replies'}${bits.length ? `: ${bits.join(', ')}` : ''}`;
  },
  // A run that drafted nothing but wrote a note says the note (a run that
  // couldn't read Google is not "no new reviews").
  nothing_due: (r, notes) => (notes[0] && !/^No new reviews/.test(notes[0]) ? notes[0] : 'No new reviews to answer'),
  blocked: (r, notes) => notes[0] || "It couldn't start this time",
  failed: (r, notes) => notes[0] || 'It could not finish',
});

export function normaliseReviewRunRow(row) {
  const notes = (() => { const v = parseJson(row.notes_json, []); return Array.isArray(v) ? v.map(String) : []; })();
  const outcome = row.status === 'running' ? 'running' : (row.outcome || (row.status === 'failed' ? 'failed' : 'nothing_due'));
  const label = outcome === 'running' ? 'Running now' : (REPLY_OUTCOME[outcome] || REPLY_OUTCOME.failed)(row, notes);
  return {
    agent: REVIEW_REPLY_AGENT.key,
    agent_label: REVIEW_REPLY_AGENT.label,
    product: 'arion',
    job_key: JOB.REVIEWS,
    playbook_version: row.playbook_version == null ? null : Number(row.playbook_version),
    run_id: String(row.run_id),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    trigger: row.trigger_source || null,
    trigger_label: row.trigger_source === 'timer' ? 'On its daily schedule' : (TRIGGER_WORDS[row.trigger_source] || 'Started by hand'),
    status: row.status,
    outcome,
    outcome_label: label,
    drafted: row.drafted == null ? null : Number(row.drafted),
    keywords: [],
    cost_note: COST_NOTE.AI,
    notes,
    failure: outcome === 'failed' ? { reason: String(row.error_plain || notes[0] || 'It stopped part-way through.').slice(0, 300) } : null,
  };
}

export async function fetchReviewRuns(pool, tenantId, { limit = 20 } = {}) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) run_id, trigger_source, status, outcome, reviews_seen, drafted, held, posted,
                   playbook_version, notes_json, error_plain, started_at, finished_at
              FROM arion.gbp_reply_run
             WHERE tenant_id = @t
             ORDER BY started_at DESC`);
  return r.recordset.map(normaliseReviewRunRow);
}

export async function loadArionRuns(pool, tenantId, { limit = 20 } = {}) {
  const degraded = [];
  const all = [];
  const sources = [
    { agent: 'content', table: 'arion.content_agent_run_log', run: () => fetchContentRuns(pool, tenantId, { limit }) },
    { agent: REVIEW_REPLY_AGENT.key, table: 'arion.gbp_reply_run', run: () => fetchReviewRuns(pool, tenantId, { limit }) },
  ];
  for (const src of sources) {
    try {
      if (!(await tableExists(pool, src.table))) {
        console.warn(`[agents:runs] ${src.table} is not in this database yet`);
        degraded.push({ agent: src.agent, error: DEGRADED_WORDS.missing });
      } else {
        all.push(...(await src.run()));
      }
    } catch (err) {
      console.error(`[agents:runs] ${src.table}:`, err);
      degraded.push({ agent: src.agent, error: DEGRADED_WORDS.unreadable });
    }
  }
  const rows = all
    .sort((a, b) => (Date.parse(b.started_at || 0) || 0) - (Date.parse(a.started_at || 0) || 0))
    .slice(0, limit);
  return {
    rows,
    meta: {
      total: rows.length,
      limit,
      failed: rows.filter((r) => r.outcome === 'failed').length,
      held: rows.filter((r) => r.outcome === 'escalated').length,
      halted: rows.filter((r) => r.outcome === 'halted').length,
      last_run_at: rows[0]?.started_at || null,
      degraded,
    },
  };
}

export default {
  TRIGGER_WORDS, FLAG_WORDS, outcomeWords, flagSentence, normaliseRunRow, normaliseReviewRunRow,
  fetchContentRuns, fetchReviewRuns, loadArionRuns,
};
