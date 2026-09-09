// lib/contentAgent/styleCompile.js — the step that makes the agent actually
// LEARN.
//
// ═══ THE GAP ═══════════════════════════════════════════════════════════════
//
// `recordSignal()` is called from the approve and reject routes, so evidence has
// been piling up in `arion.content_agent_style_signal` correctly all along — every
// edit with its edit distance, every rejection with its reason. And
// `buildProfile()`, `saveProfileVersion()` and `unconsumedSignals()` had NO CALLER
// ANYWHERE. So:
//
//   · `arion.content_agent_tenant_style` had 0 rows,
//   · `loadActiveProfile()` always returned null,
//   · `renderStyleContext()` always returned '',
//   · every draft was written from the client's DECLARED brand voice with
//     `style_profile_id = NULL`.
//
// The read half, the write half and the maths were all built and tested. The step
// that runs them on a schedule was missing. That is the capability Brandon named
// — "it needs to learn about our clients and their style" — and it is the half
// that compounds: an agent that does not fold last week's edits back in makes the
// same mistake for fifty-two weeks.
//
// ═══ NO LLM. EVERY ELEMENT TRACES TO A RECORD. ═════════════════════════════
//
// styleProfile.js's header already argues this and it is worth restating where
// the scheduling happens, because "have a model summarise the client's voice" is
// the tempting shortcut:
//
//   · measured formatting  <- counted from text the client actually PUBLISHED
//                             (arion.content_agent_output.body_markdown_final
//                             where published_at IS NOT NULL, falling back to
//                             the approved text)
//   · exemplars            <- verbatim before/after pairs from real edits,
//                             heaviest edit distance first
//   · banned vocabulary    <- words that were in the agent's draft and NOT in
//                             what shipped
//   · confidence           <- a function of how many observations exist, and it
//                             saturates below certainty
//
// Nothing is synthesised, nothing drifts, and every line of the profile can be
// traced back to a row a human's action created. Scope 14 forbids fine-tuning;
// this stays comfortably inside it, and it costs $0.
//
// ═══ WHEN IT RUNS, AND WHY IT RUNS FIRST ═══════════════════════════════════
//
// At the START of the weekly tick, before any drafting, so this week's drafts are
// written with last week's lessons already folded in. Compiling AFTER drafting
// would mean every profile version was one week behind the evidence that made it.
//
// A tenant with no unconsumed signals is SKIPPED and says so — a new profile
// version identical to the last one would burn a version number, re-stamp
// `learned_through`, and make "it learned something" indistinguishable from "the
// tick ran".

import sql from 'mssql';
import {
  unconsumedSignals, buildProfile, saveProfileVersion, loadActiveProfile,
  MIN_EVIDENCE_FOR_CONFIDENCE,
} from './styleProfile.js';

/** Outcomes, so the caller can report a skip as a skip and not as a success. */
export const COMPILE = Object.freeze({
  COMPILED: 'compiled',
  NO_NEW_EVIDENCE: 'no_new_evidence',
  FAILED: 'failed',
});

/**
 * The text a client actually shipped, newest first.
 *
 * PUBLISHED first, because a published post is proof of what the client was
 * happy to put their name on. Approved-but-unpublished is the second-best
 * evidence and is included so a business that approves faster than it publishes
 * still teaches the agent something.
 *
 * `body_markdown_final` before `body_markdown`: the edited version IS the
 * lesson. Falling back to the agent's own draft where no edit was made is
 * correct — approving something unchanged is also a signal, and it is the signal
 * that says "this was already right".
 */
export async function publishedTexts(pool, tenantId, { limit = 25 } = {}) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
             COALESCE(body_markdown_final, body_markdown) AS body,
             published_at, approved_at
        FROM arion.content_agent_output
       WHERE tenant_id = @t
         AND review_status IN ('approved','edited')
         AND COALESCE(body_markdown_final, body_markdown) IS NOT NULL
       ORDER BY CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
                COALESCE(published_at, approved_at) DESC`);
  return r.recordset.map((x) => x.body).filter(Boolean);
}

/**
 * Compile one tenant's next style profile version from its unconsumed evidence.
 *
 * @param {object} p
 * @param {import('mssql').ConnectionPool} p.pool
 * @param {string} p.tenantId
 * @param {string|null} [p.siteId]
 * @param {object} [p.deps]  test seams
 * @returns {Promise<{outcome, tenantId, signals, version?, evidenceCount?, confidence?, styleId?, reason?}>}
 *          NEVER throws — a tenant whose learning step fails must not cost the
 *          drafting cycle that follows it.
 */
export async function compileStyleProfile({ pool, tenantId, siteId = null, deps = {} }) {
  const load = deps.unconsumedSignals || unconsumedSignals;
  const texts = deps.publishedTexts || publishedTexts;
  const current = deps.loadActiveProfile || loadActiveProfile;
  const build = deps.buildProfile || buildProfile;
  const save = deps.saveProfileVersion || saveProfileVersion;
  const log = deps.log || (() => {});

  try {
    const signals = await load(pool, tenantId);
    if (!signals.length) {
      // Not a failure and not nothing: it means nobody has approved, edited or
      // rejected anything since the last compile.
      return { outcome: COMPILE.NO_NEW_EVIDENCE, tenantId, signals: 0 };
    }

    const [previous, samples] = await Promise.all([
      current(pool, tenantId),
      texts(pool, tenantId),
    ]);

    const profile = build({ signals, publishedTexts: samples, previous });
    const styleId = await save(pool, tenantId, profile, { siteId });

    log(`tenant ${tenantId}: style profile v${profile.version} from ${signals.length} new observation(s), `
      + `${profile.evidenceCount} total, confidence ${profile.confidence}`
      + (profile.evidenceCount < MIN_EVIDENCE_FOR_CONFIDENCE
        ? ' — still below the threshold, so drafts keep using the declared brand voice'
        : ''));

    return {
      outcome: COMPILE.COMPILED, tenantId, styleId,
      signals: signals.length,
      version: profile.version,
      evidenceCount: profile.evidenceCount,
      confidence: profile.confidence,
      exemplars: (profile.voice?.exemplars || []).length,
      bannedWords: (profile.vocabulary?.banned || []).length,
      // Said out loud: below the threshold the profile exists but is not USED.
      // "It learned" and "it is drafting from what it learned" are different
      // claims and conflating them is how a POC over-promises.
      inUse: profile.evidenceCount >= MIN_EVIDENCE_FOR_CONFIDENCE,
    };
  } catch (err) {
    log(`tenant ${tenantId}: style compile failed — ${err.message}`);
    return { outcome: COMPILE.FAILED, tenantId, signals: null, reason: err.message };
  }
}

/**
 * Compile for every tenant in a tick, one at a time, isolated.
 *
 * @returns {Promise<Array>} one result per tenant, in order
 */
export async function compileAll({ pool, tenants = [], deps = {} }) {
  const out = [];
  for (const t of tenants) {
    out.push(await compileStyleProfile({
      pool, tenantId: t.tenant_id || t.tenantId || t, siteId: t.site_id ?? null, deps,
    }));
  }
  return out;
}

export default { COMPILE, publishedTexts, compileStyleProfile, compileAll };
