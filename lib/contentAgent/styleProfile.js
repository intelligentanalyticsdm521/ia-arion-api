// lib/contentAgent/styleProfile.js
//
// Scope 12.11 + 12.12 — how the agent learns a client's voice, and why it can
// never learn the wrong one.
//
// Brandon 2026-08-23: "it needs to learn about our clients and their style
// (only the tenant they are currently assigned to) and then be able to do the
// content and branding according to the clients specific style."
//
// THE ISOLATION MODEL, in three layers, because one is not enough:
//
//   1. SCHEMA   — UX_content_agent_tenant_style_active is a filtered unique
//                 index on (tenant_id) WHERE is_active = 1. Two active profiles
//                 for one tenant is impossible at the database.
//   2. QUERY    — every statement here filters on tenant_id in its WHERE clause.
//                 Never fetch-then-filter-in-JS: that is one forgotten .filter()
//                 away from a cross-tenant leak and it discards the index.
//   3. ARGUMENT — assertTenantScope() refuses to build a query at all without a
//                 well-formed tenant id. Fails CLOSED. A null tenant_id in a
//                 WHERE clause matches nothing in SQL, but a null that reaches
//                 a query builder somewhere else could match everything, so the
//                 guard is at the door rather than trusting the dialect.
//
// A client's voice is their commercial property. Leaking it into a competitor's
// content would be a serious breach, and "we told the model not to" is not a
// control. Hence the layers.
//
// WHY LEARNING IS DETERMINISTIC HERE
//
// The temptation is to have an LLM "study" the client's content and emit a
// personality description. That is expensive, unauditable, and drifts. What
// actually carries the signal is far simpler: the diff between what the agent
// wrote and what Brandon published. Those before/after pairs ARE the lesson,
// and they work directly as few-shot examples with no synthesis step.
//
// So v0.1 learns by (a) measuring things that are measurable — sentence length,
// exclamation habit, heading style, paragraph rhythm — and (b) retaining the
// highest-signal edit pairs verbatim. No model call, no weights, nothing to
// drift, and every element of a profile traces to a primary record. Scope 14
// forbids fine-tuning and this stays comfortably inside that line.

import sql from 'mssql';

/** Fail closed: refuse to build a tenant-scoped query without a real tenant id. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertTenantScope(tenantId) {
  if (!tenantId || typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) {
    throw new Error(
      `[styleProfile] refusing to query without a valid tenant scope (got ${JSON.stringify(tenantId)}). `
      + 'Every style read and write is scoped to exactly one tenant.',
    );
  }
  return tenantId;
}

export const SIGNAL_KIND = {
  APPROVED_AS_IS: 'approved_as_is',
  EDITED: 'edited',
  REJECTED: 'rejected',
  PERFORMANCE: 'performance',
};

// A profile built on almost nothing should not be leaned on. The drafting step
// reads confidence to decide how hard to weight the learned style versus the
// tenant's declared brand profile.
export const MIN_EVIDENCE_FOR_CONFIDENCE = 5;
export const FULL_CONFIDENCE_EVIDENCE = 50;

/**
 * The tenant's active style profile, or null if they have none yet.
 *
 * Returns AT MOST one row — guaranteed by the filtered unique index, and the
 * TOP 1 here is belt to that braces.
 */
export async function loadActiveProfile(pool, tenantId) {
  assertTenantScope(tenantId);
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT TOP 1 style_id, tenant_id, site_id, profile_version,
             voice_json, vocabulary_json, formatting_json, brand_tokens_json,
             authority_json, evidence_count, confidence, learned_through
        FROM arion.content_agent_tenant_style
       WHERE tenant_id = @tenantId AND is_active = 1
       ORDER BY profile_version DESC`);
  const row = r.recordset[0];
  if (!row) return null;

  // Defence in depth: if a query somewhere ever returned a foreign row, refuse
  // it rather than draft in someone else's voice.
  if (String(row.tenant_id).toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new Error('[styleProfile] loaded profile does not belong to the requested tenant — refusing');
  }
  return parseProfile(row);
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function parseProfile(row) {
  return {
    styleId: row.style_id,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    version: row.profile_version,
    voice: safeJson(row.voice_json, {}),
    vocabulary: safeJson(row.vocabulary_json, { preferred: [], banned: [] }),
    formatting: safeJson(row.formatting_json, {}),
    brandTokens: safeJson(row.brand_tokens_json, {}),
    authority: safeJson(row.authority_json, { claims: [] }),
    evidenceCount: row.evidence_count ?? 0,
    confidence: row.confidence == null ? null : Number(row.confidence),
    learnedThrough: row.learned_through,
  };
}

/**
 * Record one review outcome as evidence. Called when Brandon approves, edits or
 * rejects a unit — this is the only place the profile's raw material comes from.
 */
export async function recordSignal(pool, {
  tenantId, outputId, signalKind, fieldName = null,
  beforeText = null, afterText = null, reviewerNote = null, metricJson = null,
}) {
  assertTenantScope(tenantId);
  if (!Object.values(SIGNAL_KIND).includes(signalKind)) {
    throw new Error(`[styleProfile] unknown signal kind: ${signalKind}`);
  }
  const distance = beforeText != null && afterText != null
    ? levenshteinBudgeted(beforeText, afterText)
    : null;

  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('outputId', sql.UniqueIdentifier, outputId || null)
    .input('kind', sql.NVarChar(30), signalKind)
    .input('field', sql.NVarChar(80), fieldName)
    .input('before', sql.NVarChar(sql.MAX), beforeText)
    .input('after', sql.NVarChar(sql.MAX), afterText)
    .input('dist', sql.Int, distance)
    .input('note', sql.NVarChar(sql.MAX), reviewerNote)
    .input('metric', sql.NVarChar(sql.MAX), metricJson ? JSON.stringify(metricJson) : null)
    .query(`
      INSERT INTO arion.content_agent_style_signal
        (tenant_id, output_id, signal_kind, field_name, before_text, after_text,
         edit_distance, reviewer_note, metric_json)
      VALUES (@tenantId, @outputId, @kind, @field, @before, @after, @dist, @note, @metric)`);
}

/**
 * Edit distance, capped so a pathological pair cannot burn the run.
 * Only used as a magnitude signal ("was this a tweak or a rewrite"), so an
 * approximate answer above the cap is fine.
 */
export function levenshteinBudgeted(a, b, cap = 4000) {
  const s = String(a || '').slice(0, cap);
  const t = String(b || '').slice(0, cap);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/** Unconsumed signals for this tenant — the material for the next version. */
export async function unconsumedSignals(pool, tenantId, { limit = 500 } = {}) {
  assertTenantScope(tenantId);
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) signal_id, signal_kind, field_name, before_text,
             after_text, edit_distance, reviewer_note, observed_at
        FROM arion.content_agent_style_signal
       WHERE tenant_id = @tenantId AND consumed_at IS NULL
       ORDER BY observed_at ASC`);
  return r.recordset;
}

// ---------------------------------------------------------------------------
// The measurable half of a style
// ---------------------------------------------------------------------------

/**
 * Derive formatting habits from text the tenant actually published. Pure.
 * Everything here is countable — no interpretation, so nothing to hallucinate.
 */
export function measureStyle(texts) {
  const bodies = (texts || []).map((t) => String(t || '')).filter(Boolean);
  if (!bodies.length) return null;

  const sentences = [];
  let exclamations = 0;
  let questions = 0;
  let headings = 0;
  let bullets = 0;
  const paraLengths = [];

  for (const body of bodies) {
    exclamations += (body.match(/!/g) || []).length;
    questions += (body.match(/\?/g) || []).length;
    headings += (body.match(/^#{1,6}\s/gm) || []).length;
    bullets += (body.match(/^\s*[-*]\s/gm) || []).length;
    for (const p of body.split(/\n\s*\n/).filter((x) => x.trim())) {
      paraLengths.push(p.trim().split(/\s+/).length);
    }
    for (const s of body.split(/(?<=[.!?])\s+/).filter((x) => x.trim())) {
      sentences.push(s.trim().split(/\s+/).length);
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const totalWords = bodies.reduce((n, b) => n + b.split(/\s+/).filter(Boolean).length, 0);

  return {
    sampleSize: bodies.length,
    avgSentenceWords: Math.round(mean(sentences) * 10) / 10,
    avgParagraphWords: Math.round(mean(paraLengths) * 10) / 10,
    // per 1000 words, so the habit is comparable across sample sizes
    exclamationsPer1k: totalWords ? Math.round((exclamations / totalWords) * 1000 * 100) / 100 : 0,
    questionsPer1k: totalWords ? Math.round((questions / totalWords) * 1000 * 100) / 100 : 0,
    usesHeadings: headings > 0,
    usesBullets: bullets > 0,
    headingsPerPost: Math.round((headings / bodies.length) * 10) / 10,
  };
}

/** Confidence rises with evidence and saturates — never reaches certainty. */
export function confidenceFor(evidenceCount) {
  const n = Number(evidenceCount) || 0;
  if (n < MIN_EVIDENCE_FOR_CONFIDENCE) return 0;
  const ratio = Math.min(1, (n - MIN_EVIDENCE_FOR_CONFIDENCE) / (FULL_CONFIDENCE_EVIDENCE - MIN_EVIDENCE_FOR_CONFIDENCE));
  return Math.round(ratio * 0.95 * 10000) / 10000;
}

/**
 * Build the next profile version from signals + published samples. Pure, so the
 * learning rule is testable without a database.
 */
export function buildProfile({ signals = [], publishedTexts = [], previous = null }) {
  const edits = signals.filter((s) => s.signal_kind === SIGNAL_KIND.EDITED && s.before_text && s.after_text);
  const rejects = signals.filter((s) => s.signal_kind === SIGNAL_KIND.REJECTED);
  const approvals = signals.filter((s) => s.signal_kind === SIGNAL_KIND.APPROVED_AS_IS);

  const measured = measureStyle(publishedTexts) || previous?.formatting?.measured || null;

  // The highest-signal edits are the heaviest ones — a reworded headline teaches
  // more than a comma. Keep a bounded set so the prompt stays affordable.
  const exemplars = [...edits]
    .sort((a, b) => (b.edit_distance || 0) - (a.edit_distance || 0))
    .slice(0, 12)
    .map((s) => ({
      field: s.field_name,
      agentWrote: String(s.before_text).slice(0, 600),
      publishedAs: String(s.after_text).slice(0, 600),
      note: s.reviewer_note || null,
    }));

  // Words the agent used that survived to publication vs words that got edited
  // out. Crude but honest, and it traces to real edits rather than to a guess.
  const banned = new Set(previous?.vocabulary?.banned || []);
  for (const e of edits) {
    const before = new Set(String(e.before_text).toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
    const after = new Set(String(e.after_text).toLowerCase().match(/\b[a-z]{5,}\b/g) || []);
    for (const w of before) if (!after.has(w)) banned.add(w);
  }

  const evidenceCount = (previous?.evidenceCount || 0) + signals.length;

  return {
    version: (previous?.version || 0) + 1,
    voice: {
      exemplars,
      approvedAsIsRate: signals.length ? Math.round((approvals.length / signals.length) * 100) / 100 : null,
      rejectionCount: rejects.length,
    },
    vocabulary: {
      preferred: previous?.vocabulary?.preferred || [],
      // bounded: an unbounded ban list would eventually forbid the language
      banned: [...banned].slice(0, 200),
    },
    formatting: { measured },
    brandTokens: previous?.brandTokens || {},
    authority: previous?.authority || { claims: [] },
    evidenceCount,
    confidence: confidenceFor(evidenceCount),
  };
}

/**
 * Persist a new version and make it the active one, atomically.
 *
 * The deactivate + insert must be one transaction: between them there would
 * otherwise be a window with zero active profiles (a run in that window drafts
 * with no learned style) or, if ordered the other way, two active profiles —
 * which the unique index would reject and roll the whole thing back anyway.
 */
export async function saveProfileVersion(pool, tenantId, profile, { siteId = null } = {}) {
  assertTenantScope(tenantId);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('UPDATE arion.content_agent_tenant_style SET is_active = 0, updated_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND is_active = 1');

    const ins = await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('ver', sql.Int, profile.version)
      .input('voice', sql.NVarChar(sql.MAX), JSON.stringify(profile.voice || {}))
      .input('vocab', sql.NVarChar(sql.MAX), JSON.stringify(profile.vocabulary || {}))
      .input('fmt', sql.NVarChar(sql.MAX), JSON.stringify(profile.formatting || {}))
      .input('tokens', sql.NVarChar(sql.MAX), JSON.stringify(profile.brandTokens || {}))
      .input('auth', sql.NVarChar(sql.MAX), JSON.stringify(profile.authority || {}))
      .input('ev', sql.Int, profile.evidenceCount || 0)
      .input('conf', sql.Decimal(5, 4), profile.confidence ?? null)
      .query(`
        INSERT INTO arion.content_agent_tenant_style
          (tenant_id, site_id, profile_version, voice_json, vocabulary_json,
           formatting_json, brand_tokens_json, authority_json,
           evidence_count, confidence, learned_through, is_active)
        OUTPUT INSERTED.style_id
        VALUES (@tenantId, @siteId, @ver, @voice, @vocab, @fmt, @tokens, @auth,
                @ev, @conf, SYSDATETIMEOFFSET(), 1)`);

    await new sql.Request(tx)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('UPDATE arion.content_agent_style_signal SET consumed_at = SYSDATETIMEOFFSET() WHERE tenant_id = @tenantId AND consumed_at IS NULL');

    await tx.commit();
    return ins.recordset[0].style_id;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Render a profile as prompt context.
 *
 * Returns '' when there is no profile or too little evidence — an empty string
 * means "draft from the declared brand profile alone", which is the correct
 * cold-start behaviour. Inventing a voice from four data points would be worse
 * than having none.
 */
export function renderStyleContext(profile) {
  if (!profile) return '';
  if ((profile.evidenceCount || 0) < MIN_EVIDENCE_FOR_CONFIDENCE) return '';

  const lines = ['LEARNED STYLE FOR THIS CLIENT (from their own published content and prior review outcomes):'];
  const m = profile.formatting?.measured;
  if (m) {
    lines.push(`- Sentences average ${m.avgSentenceWords} words; paragraphs average ${m.avgParagraphWords} words.`);
    lines.push(`- Exclamation points: ${m.exclamationsPer1k} per 1000 words. Match this restraint.`);
    if (m.usesHeadings) lines.push(`- Uses section headings, about ${m.headingsPerPost} per post.`);
    if (m.usesBullets) lines.push('- Uses bulleted lists.');
  }
  const banned = profile.vocabulary?.banned || [];
  if (banned.length) {
    lines.push(`- Avoid these words, which were edited out of previous drafts: ${banned.slice(0, 40).join(', ')}.`);
  }
  const ex = profile.voice?.exemplars || [];
  if (ex.length) {
    lines.push('');
    lines.push('EDITS MADE TO PREVIOUS DRAFTS — the left side is what was written, the right is what actually published. Write like the right side:');
    for (const e of ex.slice(0, 6)) {
      lines.push(`  [${e.field || 'body'}] BEFORE: ${e.agentWrote.slice(0, 220)}`);
      lines.push(`  [${e.field || 'body'}] AFTER:  ${e.publishedAs.slice(0, 220)}`);
    }
  }
  lines.push('');
  lines.push(`(Profile v${profile.version}, ${profile.evidenceCount} observations, confidence ${profile.confidence}.)`);
  return lines.join('\n');
}

export default {
  assertTenantScope, SIGNAL_KIND, loadActiveProfile, parseProfile, recordSignal,
  levenshteinBudgeted, unconsumedSignals, measureStyle, confidenceFor,
  buildProfile, saveProfileVersion, renderStyleContext,
  MIN_EVIDENCE_FOR_CONFIDENCE,
};
