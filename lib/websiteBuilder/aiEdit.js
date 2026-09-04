/**
 * "Tell the AI what you want, preview, approve" — the propose-only half.
 * ---------------------------------------------------------------------------
 * SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.8, Phase 1B.
 *
 * THE ONE RULE THIS FILE ENFORCES
 *
 *   Nothing here writes to a client's website. Ever. It takes a plain-English
 *   instruction plus the section's CURRENT field values, asks the model for a
 *   new set of FIELD VALUES (never Elementor JSON), validates them against
 *   sectionSchema, and hands back a proposal. The proposal reaches the site
 *   only when the client taps Approve, and Approve runs the ordinary save
 *   path — same snapshot, same publish control, so Undo covers an AI edit
 *   exactly as it covers a typed one.
 *
 *   This is the Content agent's locked rule (project_arion_content_agent:
 *   generation is PROPOSE-ONLY) applied to page content.
 *
 * WHY FIELDS AND NOT ELEMENTOR JSON
 *
 *   A model that emits Elementor JSON can emit anything: a broken tree, a
 *   dropped form, a stripped tracking script. A model that emits
 *   { headline: "...", cta_text: "..." } can only ever change the words we
 *   already let a human change through the edit sheet — the same
 *   `applyFields` patch, the same validation, the same round-trip guarantee.
 *   The blast radius of a bad generation is one heading.
 *
 * TIERS (W-4 + feedback_intelligence_tier_data_gated)
 *
 *   The EDITOR is on every ARION tier including Lite — that is the locked
 *   2026-06-28 decision and it is what makes a $19.99 Lite site an honest
 *   product. The AI actions inside it are not: "Lite never gets LLM". The
 *   gate below is an ALLOWLIST of paid tiers, not a "not lite" test — an
 *   absence-based guard fails open the first time a tier arrives spelled a
 *   way nobody predicted (reference_absence_based_guards_fail_open).
 *
 * NAMING (reference_intelligence_layer_terminology)
 *
 *   Internally this is ARION IL. Every string a client can read says
 *   "Powered by ARGUS AI". The provider is never named, here or anywhere the
 *   Portal renders.
 */

import { randomUUID } from 'node:crypto';
import { meterAndAudit } from '../argus/callWrapper.js';
import { callAnthropic } from './anthropicClient.js';
import {
  SECTION_KINDS, sectionKindMeta, validateProposedFields, FORM_PURPOSES,
} from './sectionSchema.js';

/* ==========================================================================
 * Tiers, actions and models
 * ======================================================================== */

/**
 * PRESENCE gate. A site is allowed an AI action when its tier is one of
 * these, full stop. Unknown, empty, misspelled and NULL all land outside the
 * set and are refused — which is the safe direction, because the refusal is
 * an upsell the client can act on, not a silent charge.
 */
export const AI_PAID_TIERS = Object.freeze(new Set(['standard', 'pro', 'business', 'enterprise']));

/** What a client is told when their plan does not include the AI actions. */
export const LITE_UPSELL =
  'Asking ARGUS AI to write your website copy is part of ARION Standard and above. '
  + 'You can still change every word and picture on this page yourself, on any plan.';

export const ACTION_SECTION_EDIT = 'arion.site_edit_section';
export const ACTION_PAGE_EDIT = 'arion.site_edit_page';

// Model per action. Sized in db/migrations/059_site_edit_proposal.sql, which
// carries the credit arithmetic; these two must stay in step with that file.
export const MODEL_SECTION_EDIT = 'claude-haiku-4-5';
export const MODEL_PAGE_EDIT = 'claude-sonnet-5';

export const MAX_INSTRUCTION_CHARS = 1000;
/** A page-level instruction may propose at most this many brand-new sections. */
export const MAX_PROPOSED_SECTIONS = 3;

/**
 * @param {object} site  an arion.site row
 * @returns {{ allowed: boolean, tier: string|null, message: string|null }}
 */
export function aiTierGate(site) {
  const tier = String(site?.arion_tier || '').trim().toLowerCase() || null;
  if (tier && AI_PAID_TIERS.has(tier)) return { allowed: true, tier, message: null };
  return { allowed: false, tier, message: LITE_UPSELL };
}

/* ==========================================================================
 * Prompting — the model is told the field list, in the schema's own words
 * ======================================================================== */

/**
 * One line per field: the key, what a person calls it, and its shape.
 *
 * Fields marked `notForAi` are LEFT OUT ENTIRELY — where a form's enquiries
 * go, what kind of enquiry it is, which attachment a picture points at. Not
 * naming them is the cheap half of the guard (a model cannot rewrite a field
 * it was never told about); `validateProposedFields` refusing them outright
 * is the half that has to hold, and both are mutation-tested.
 */
function fieldLines(kind) {
  const meta = sectionKindMeta(kind);
  if (!meta) return '';
  return meta.fields.filter((spec) => !spec.notForAi).map((spec) => {
    const bits = [`- ${spec.key} (${spec.type})`, `“${spec.label}”`];
    if (spec.required) bits.push('REQUIRED');
    if (spec.max) bits.push(`max ${spec.max}${spec.type === 'list' || spec.type === 'paragraphs' ? ' entries' : ' characters'}`);
    if (Array.isArray(spec.options)) bits.push(`one of: ${spec.options.join(' | ')}`);
    if (spec.type === 'list' && Array.isArray(spec.item)) {
      const sub = spec.item.filter((s) => !s.notForAi)
        .map((s) => `${s.key} (${s.type})${s.required ? ' REQUIRED' : ''}`).join(', ');
      bits.push(`each row has: { ${sub} }`);
    }
    if (spec.type === 'paragraphs') bits.push('an array of plain strings');
    return bits.join(' · ');
  }).join('\n');
}

function brandLines(brand) {
  if (!brand) return '(no business details on file)';
  const rows = [
    ['Business', brand.business_name],
    ['What they do', brand.industry],
    ['In their words', brand.description],
    ['Tagline', brand.tagline],
    ['Who they serve', brand.target_audience],
    ['Services', Array.isArray(brand.services) ? brand.services.join(', ') : ''],
    ['Where', brand.location],
    ['Tone of voice', brand.brand_voice],
  ];
  const kept = rows.filter(([, v]) => String(v || '').trim().length > 0);
  return kept.length ? kept.map(([k, v]) => `${k}: ${v}`).join('\n') : '(no business details on file)';
}

const COMMON_RULES = [
  'Write as the business, in the tone of voice given. British or American spelling — match whatever the existing copy uses.',
  'Keep the same language as the existing copy.',
  'Never invent a fact: no prices, no phone numbers, no addresses, no opening hours, no awards, no statistics that are not already in the material you were given.',
  'Never mention artificial intelligence, a model, a vendor, or that this text was generated.',
  'Respect every length limit. Copy that is one character over is copy the client cannot save.',
  'Only include a field you are actually changing. Leave everything else out.',
  'Answer with JSON only. No prose, no markdown fences.',
];

export function buildSectionPrompt({ kind, fields, brand, instruction }) {
  const meta = sectionKindMeta(kind);
  const system = [
    `You rewrite the copy of one section of a small business's website.`,
    '',
    `The section is a “${meta.label}” — ${meta.blurb}`,
    '',
    'These are the only fields it has. You may return any subset of them and nothing else:',
    fieldLines(kind),
    '',
    'Rules:',
    ...COMMON_RULES.map((r) => `- ${r}`),
    '',
    'Reply with exactly this shape:',
    '{ "fields": { …only the fields you changed… }, "summary": "one short sentence describing what you changed" }',
  ].join('\n');

  const user = [
    'THE BUSINESS',
    brandLines(brand),
    '',
    'WHAT THE SECTION SAYS NOW',
    JSON.stringify(fields ?? {}, null, 1),
    '',
    'WHAT THE OWNER ASKED FOR',
    String(instruction || '').trim(),
  ].join('\n');

  return { system, user };
}

export function buildPagePrompt({ page, brand, instruction, allowedKinds }) {
  const kindLines = allowedKinds.map((k) => {
    const meta = SECTION_KINDS[k];
    return `- ${k}: ${meta.label} — ${meta.blurb}`;
  }).join('\n');

  const system = [
    `You are changing one page of a small business's website, working only in plain content fields.`,
    '',
    'You are given every section on the page in order. Sections marked "locked" were built directly on the website and you must not touch them — leave them out of your answer entirely.',
    '',
    'You may do two things:',
    '  1. change the fields of an editable section, and',
    `  2. add up to ${MAX_PROPOSED_SECTIONS} brand-new sections, each of one of these kinds:`,
    kindLines,
    '',
    'The fields of each kind are:',
    allowedKinds.map((k) => `## ${k}\n${fieldLines(k)}`).join('\n\n'),
    '',
    'Rules:',
    ...COMMON_RULES.map((r) => `- ${r}`),
    '- Change as little as the request needs. A request about tone is not a licence to rewrite the whole page.',
    '- Only add a section when the request actually asks for new content that has nowhere to live.',
    '',
    'Reply with exactly this shape:',
    '{ "edits": [ { "index": <the section index>, "fields": { … } } ],',
    '  "add_sections": [ { "kind": "<kind>", "after_index": <index or -1 for the top>, "fields": { … } } ],',
    '  "summary": "one short sentence describing what you changed" }',
  ].join('\n');

  const user = [
    'THE BUSINESS',
    brandLines(brand),
    '',
    'THE PAGE AS IT IS NOW',
    JSON.stringify(page, null, 1),
    '',
    'WHAT THE OWNER ASKED FOR',
    String(instruction || '').trim(),
  ].join('\n');

  return { system, user };
}

/* ==========================================================================
 * The plain-words diff — what the client actually reads before approving
 * ======================================================================== */

function shorten(value, max = 90) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s == null) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/**
 * One entry per field the proposal would actually change, in the words the
 * edit sheet uses. A field whose value is unchanged never appears — a diff
 * that lists a line that does not change is a diff the client stops reading.
 *
 * @returns {Array<{ field:string, label:string, kind:'text'|'list', before:any, after:any, beforeText:string, afterText:string }>}
 */
export function buildDiff(kind, before, after) {
  const meta = sectionKindMeta(kind);
  if (!meta) return [];
  const rows = [];
  const countText = (n, spec) => {
    const one = String(spec.itemLabel || 'entry').toLowerCase();
    const many = /s$/.test(one) ? one : `${one}s`;
    return `${n} ${n === 1 ? one : many}`;
  };
  for (const spec of meta.fields) {
    // A hidden field has no words for a person to compare, so it can never
    // be a row in a before/after a client is asked to approve.
    if (spec.type === 'hidden') continue;
    if (!Object.prototype.hasOwnProperty.call(after || {}, spec.key)) continue;
    const b = before?.[spec.key];
    const a = after[spec.key];
    if (sameValue(a, b)) continue;
    const isList = spec.type === 'list' || spec.type === 'paragraphs';
    rows.push({
      field: spec.key,
      label: spec.label,
      kind: isList ? 'list' : 'text',
      before: b === undefined ? null : b,
      after: a,
      beforeText: isList ? countText(Array.isArray(b) ? b.length : 0, spec) : shorten(b ?? ''),
      afterText: isList ? countText(Array.isArray(a) ? a.length : 0, spec) : shorten(a ?? ''),
    });
  }
  return rows;
}

/** The same diff as one block of text, for the stored row and the audit. */
export function diffToPlain(rows) {
  if (!rows || rows.length === 0) return 'Nothing would change.';
  return rows.map((r) => `${r.label}: “${r.beforeText}” → “${r.afterText}”`).join('\n');
}

/* ==========================================================================
 * Reading the model's answer
 * ======================================================================== */

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * Coerce a scalar the model may have sent as the wrong primitive. Deliberately
 * narrow: numbers and booleans become strings for text fields, and that is
 * all. Anything else is left exactly as it came so the validator refuses it
 * rather than this function quietly making a bad payload look good.
 */
function coerceFields(kind, fields) {
  const meta = sectionKindMeta(kind);
  if (!meta) return fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const spec = meta.fields.find((s) => s.key === key);
    if (spec && ['text', 'textarea', 'link', 'email', 'image', 'choice', 'icon'].includes(spec.type)
        && (typeof value === 'number' || typeof value === 'boolean')) {
      out[key] = String(value);
      continue;
    }
    if (spec && spec.type === 'paragraphs' && typeof value === 'string') {
      // A model asked for "an array of plain strings" sometimes sends one
      // string with newlines in it. That is the same content, so take it.
      out[key] = value.split(/\n{1,}/).map((s) => s.trim()).filter(Boolean);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/* ==========================================================================
 * Proposing — ONE metered call, nothing written
 * ======================================================================== */

function tooLong(instruction) {
  return String(instruction || '').trim().length > MAX_INSTRUCTION_CHARS;
}

/**
 * Ask for a rewrite of ONE section.
 *
 * @param {object} args
 * @param {object} args.pool         services SQL pool (metering + audit)
 * @param {string} args.tenantId
 * @param {string} [args.userId]
 * @param {object} args.site         the arion.site row — carries the tier
 * @param {string} args.kind         the section archetype
 * @param {object} args.fields       the section's current field values
 * @param {object} args.brand        brandContext (already carries the Business Profile)
 * @param {string} args.instruction  what the owner typed
 * @param {function} [args.callModel] test seam; defaults to the real client
 * @returns {Promise<{ok:boolean, error?:object, proposal?:object, audit?:object}>}
 */
export async function proposeSectionEdit({
  pool, tenantId, userId, site, kind, fields, brand, instruction, callModel = callAnthropic,
}) {
  const meta = sectionKindMeta(kind);
  if (!meta) {
    return { ok: false, error: { code: 'UNKNOWN_SECTION', status: 400, message: `We do not have a section called "${kind}".` } };
  }
  if (!String(instruction || '').trim()) {
    return { ok: false, error: { code: 'NO_INSTRUCTION', status: 400, message: 'Tell us what you would like changed first.' } };
  }
  if (tooLong(instruction)) {
    return {
      ok: false,
      error: {
        code: 'INSTRUCTION_TOO_LONG', status: 400,
        message: `Keep the request under ${MAX_INSTRUCTION_CHARS} characters — a sentence or two works best.`,
      },
    };
  }

  // The tier gate comes BEFORE the model call, not after. A refused plan must
  // never cost a token, and must never cost a credit.
  const gate = aiTierGate(site);
  if (!gate.allowed) {
    return { ok: false, error: { code: 'AI_NOT_ON_THIS_PLAN', status: 403, message: gate.message, upgrade: { current_tier: gate.tier } } };
  }

  const { system, user } = buildSectionPrompt({ kind, fields, brand, instruction });

  let raw = null;
  const metered = await meterAndAudit({
    pool, tenantId, userId,
    actionType: ACTION_SECTION_EDIT,
    provider: 'anthropic',
    model: MODEL_SECTION_EDIT,
    meta: { surface: 'arion.site_builder', scope: 'section', kind },
    runCall: async () => {
      const out = await callModel({
        model: MODEL_SECTION_EDIT, system, user, maxTokens: 1200, responseFormat: 'json',
      });
      if (!out?.ok) {
        const err = new Error(out?.error?.message || 'The writing service did not answer.');
        err.code = out?.error?.code;
        throw err;
      }
      raw = out.data;
      return { inputTokens: out.inputTokens || 0, outputTokens: out.outputTokens || 0, data: out.data };
    },
  });

  if (!metered.ok) return { ok: false, error: meterErrorToHttp(metered.error) };

  const body = asObject(raw);
  const proposed = asObject(body?.fields);
  if (!proposed) {
    return { ok: false, error: { code: 'AI_UNREADABLE', status: 502, message: 'ARGUS AI answered in a shape we could not use. Nothing was changed — try asking again.' }, audit: metered.audit };
  }

  const coerced = coerceFields(kind, proposed);
  const check = validateProposedFields(kind, coerced, { existing: fields || {} });
  if (!check.ok) {
    return {
      ok: false,
      error: {
        code: 'AI_PROPOSAL_INVALID', status: 422,
        message: 'ARGUS AI suggested something this section cannot hold, so we did not use it. Nothing was changed.',
        errors: check.errors,
      },
      audit: metered.audit,
    };
  }

  const after = { ...(fields || {}), ...coerced };
  const diff = buildDiff(kind, fields || {}, after);

  return {
    ok: true,
    audit: metered.audit,
    proposal: {
      proposal_id: randomUUID(),
      scope: 'section',
      kind,
      before: fields || {},
      after,
      diff,
      diff_plain: diffToPlain(diff),
      summary: typeof body?.summary === 'string' ? body.summary.slice(0, 300) : '',
      cost_units: metered.audit?.credits_charged ?? null,
      model: MODEL_SECTION_EDIT,
    },
  };
}

/**
 * Ask for a change across a WHOLE page — "make the tone warmer", "add a
 * section about winter services".
 *
 * `sections` is the editor's own list: every entry carries `index`, `kind`,
 * `editable` and `fields`. A locked section is described to the model so it
 * understands the page, and is refused as an edit target.
 */
export async function proposePageEdit({
  pool, tenantId, userId, site, sections, brand, instruction, callModel = callAnthropic,
}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return { ok: false, error: { code: 'NO_SECTIONS', status: 400, message: 'There is nothing on this page to change yet.' } };
  }
  if (!String(instruction || '').trim()) {
    return { ok: false, error: { code: 'NO_INSTRUCTION', status: 400, message: 'Tell us what you would like changed first.' } };
  }
  if (tooLong(instruction)) {
    return {
      ok: false,
      error: {
        code: 'INSTRUCTION_TOO_LONG', status: 400,
        message: `Keep the request under ${MAX_INSTRUCTION_CHARS} characters — a sentence or two works best.`,
      },
    };
  }

  const gate = aiTierGate(site);
  if (!gate.allowed) {
    return { ok: false, error: { code: 'AI_NOT_ON_THIS_PLAN', status: 403, message: gate.message, upgrade: { current_tier: gate.tier } } };
  }

  const allowPro = AI_PAID_TIERS.has(String(site?.arion_tier || '').toLowerCase());
  const allowedKinds = Object.keys(SECTION_KINDS)
    .filter((k) => allowPro || !SECTION_KINDS[k].requiresElementorPro);

  const pageForModel = sections.map((s) => (s.editable && s.kind
    ? { index: s.index, kind: s.kind, name: sectionKindMeta(s.kind)?.label || s.kind, fields: s.fields || {} }
    : { index: s.index, kind: null, name: 'locked', locked: true }));

  const { system, user } = buildPagePrompt({ page: pageForModel, brand, instruction, allowedKinds });

  let raw = null;
  const metered = await meterAndAudit({
    pool, tenantId, userId,
    actionType: ACTION_PAGE_EDIT,
    provider: 'anthropic',
    model: MODEL_PAGE_EDIT,
    meta: { surface: 'arion.site_builder', scope: 'page', sections: sections.length },
    runCall: async () => {
      const out = await callModel({
        model: MODEL_PAGE_EDIT, system, user, maxTokens: 4000, responseFormat: 'json',
      });
      if (!out?.ok) {
        const err = new Error(out?.error?.message || 'The writing service did not answer.');
        err.code = out?.error?.code;
        throw err;
      }
      raw = out.data;
      return { inputTokens: out.inputTokens || 0, outputTokens: out.outputTokens || 0, data: out.data };
    },
  });

  if (!metered.ok) return { ok: false, error: meterErrorToHttp(metered.error) };

  const body = asObject(raw);
  if (!body) {
    return { ok: false, error: { code: 'AI_UNREADABLE', status: 502, message: 'ARGUS AI answered in a shape we could not use. Nothing was changed — try asking again.' }, audit: metered.audit };
  }

  const byIndex = new Map(sections.map((s) => [Number(s.index), s]));
  const edits = [];
  const errors = [];

  for (const entry of (Array.isArray(body.edits) ? body.edits : [])) {
    const index = Number(entry?.index);
    const target = byIndex.get(index);
    if (!target) {
      errors.push({ field: `edits[${index}]`, message: 'ARGUS AI referred to a section that is not on this page.' });
      continue;
    }
    // A locked section is one the client built on the website itself. The
    // model was told not to touch it; if it did anyway, that is a refusal,
    // not a silent drop (SCOPE §3.3 — a custom section round-trips untouched).
    if (!target.editable || !target.kind) {
      errors.push({ field: `edits[${index}]`, message: 'ARGUS AI tried to change a section that was built on the website itself.' });
      continue;
    }
    const proposed = asObject(entry?.fields);
    if (!proposed) continue;
    const coerced = coerceFields(target.kind, proposed);
    const after = { ...(target.fields || {}), ...coerced };
    const check = validateProposedFields(target.kind, coerced, { existing: target.fields || {} });
    if (!check.ok) {
      errors.push(...check.errors.map((e) => ({ field: `edits[${index}].${e.field}`, message: e.message })));
      continue;
    }
    const diff = buildDiff(target.kind, target.fields || {}, after);
    if (diff.length === 0) continue;
    edits.push({ index, kind: target.kind, label: sectionKindMeta(target.kind)?.label || target.kind, before: target.fields || {}, after, diff });
  }

  const additions = [];
  for (const entry of (Array.isArray(body.add_sections) ? body.add_sections : []).slice(0, MAX_PROPOSED_SECTIONS)) {
    const kind = String(entry?.kind || '').toLowerCase();
    if (!allowedKinds.includes(kind)) {
      errors.push({ field: 'add_sections', message: `ARGUS AI suggested a “${kind}” section, which is not one this website can have.` });
      continue;
    }
    const proposed = asObject(entry?.fields) || {};
    const coerced = coerceFields(kind, proposed);
    // A brand-new section is a FRAGMENT: the rest of its fields come from the
    // starter the server builds around it, which is then validated in full on
    // the way into the editor (routes/arion/pages.js). Refusing it here for a
    // field it was never asked to write would kill every proposed contact
    // section, whose recipient comes from the business details.
    const check = validateProposedFields(kind, coerced, { partial: true });
    if (!check.ok) {
      errors.push(...check.errors.map((e) => ({ field: `add_sections.${e.field}`, message: e.message })));
      continue;
    }
    const afterIndex = Number.isInteger(Number(entry?.after_index)) ? Number(entry.after_index) : sections.length - 1;
    additions.push({
      kind,
      label: sectionKindMeta(kind)?.label || kind,
      afterIndex: Math.max(-1, Math.min(afterIndex, sections.length - 1)),
      fields: coerced,
      diff: buildDiff(kind, {}, coerced),
    });
  }

  if (edits.length === 0 && additions.length === 0) {
    return {
      ok: false,
      audit: metered.audit,
      error: {
        code: 'AI_NOTHING_TO_CHANGE', status: 422,
        message: errors.length
          ? 'ARGUS AI suggested something this page cannot hold, so we did not use it. Nothing was changed.'
          : 'ARGUS AI did not find anything to change for that request. Try describing it a different way.',
        errors,
      },
    };
  }

  const plain = [
    ...edits.map((e) => `${e.label}\n${diffToPlain(e.diff)}`),
    ...additions.map((a) => `New ${a.label.toLowerCase()} section: “${shorten(a.fields.headline || '', 80)}”`),
  ].join('\n\n');

  return {
    ok: true,
    audit: metered.audit,
    proposal: {
      proposal_id: randomUUID(),
      scope: 'page',
      edits,
      additions,
      skipped: errors,
      diff_plain: plain,
      summary: typeof body?.summary === 'string' ? body.summary.slice(0, 300) : '',
      cost_units: metered.audit?.credits_charged ?? null,
      model: MODEL_PAGE_EDIT,
    },
  };
}

/* ==========================================================================
 * Metering failures, in words a client can act on
 * ======================================================================== */

export function meterErrorToHttp(err) {
  const code = err?.code || 'provider_error';
  if (code === 'insufficient_credits') {
    return {
      code: 'NOT_ENOUGH_CREDITS', status: 402,
      message: `This needs ${err.required} ARGUS credits and you have ${err.balance}. Top up and try again.`,
      balance: err.balance ?? null, required: err.required ?? null,
    };
  }
  if (code === 'argus_spend_disabled') {
    return { code: 'AI_UNAVAILABLE', status: 503, message: 'ARGUS AI is switched off just now. Nothing was changed — try again shortly.' };
  }
  if (code === 'unknown_action') {
    // The pricing row is missing. Do NOT fall back to an unmetered call: a
    // free generation is a generation nobody can account for.
    return { code: 'AI_UNAVAILABLE', status: 503, message: 'ARGUS AI is not switched on for this yet. Nothing was changed.' };
  }
  return { code: 'AI_FAILED', status: 502, message: 'ARGUS AI could not answer just now. Nothing was changed — try again in a moment.' };
}

export const __test__ = {
  fieldLines, brandLines, coerceFields, shorten, sameValue, asObject, FORM_PURPOSES,
};
