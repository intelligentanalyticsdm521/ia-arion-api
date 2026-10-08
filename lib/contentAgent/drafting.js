// lib/contentAgent/drafting.js
//
// Task 3 — the drafting pipeline.
//
// Takes a selected topic plus the tenant's learned style and produces a
// structured content unit, or refuses. It never produces something halfway.
//
// AC4 IS THE SHAPE OF THIS FILE: "when SE Ranking or the Claude API is
// unavailable mid-run, the run halts cleanly, logs the failure, and never
// queues partial or garbled content."
//
// That is deliberately the OPPOSITE of the house pattern in lib/aiCopy.js,
// which catches everything and returns `{...fallback, source:'fallback-...'}`
// so the caller always gets something. For onboarding copy that is right — a
// generic About page beats a broken signup. For this agent it is wrong: a
// fallback draft is content in the client's name that nobody wrote, and scope
// 12.9 says "no partial or garbled content is ever queued for review."
//
// So every failure here THROWS. The runner catches, marks the run failed, and
// queues nothing.
//
// MODEL CALLS GO THROUGH meterAndAudit — never raw fetch. That wrapper checks
// the credit balance, enforces the per-call outlier cap, writes
// lumen.ai_call_audit, and debits. Calling Anthropic directly would bypass all
// four and leave the run log lying about what a cycle cost.

import sql from 'mssql';
import { meterAndAudit } from '../argus/callWrapper.js';
import { MODELS, DRAFT, ALLOW_MODEL_FALLBACK } from './config.js';
import { renderStyleContext } from './styleProfile.js';
import { runGuardrails } from './guardrails.js';
import { spendGuarded } from './costBreaker.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export class DraftingError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'DraftingError';
    this.code = code;
    this.detail = detail;
  }
}

/** Action types — must match rows in the ARGUS action-pricing table.
 *
 *  Seeded by LUMEN migration 149 (written as 135; renumbered on the line). ⚠ 149
 *  inserts into lumen.argus_action_pricing ONLY, and this repo resolves the
 *  table through lib/argus/tables.js, which prefers argus.action_pricing once the
 *  132 consolidation is in place — as it is on dev and prod. So the rows exist in
 *  the table nobody reads and every metered call here answers unknown_action.
 *  Recorded in MASTER_DEFECT_REGISTER.md 4d; the fix is a LUMEN migration that
 *  seeds the consolidated table, not a second lookup path here. */
export const ACTION = {
  BLOG: 'arion.content_draft',
  SOCIAL: 'arion.social_copy',
  SCAN: 'arion.content_quality_scan',
};

export function actionForContentType(contentType) {
  return contentType === 'blog_post' ? ACTION.BLOG : ACTION.SOCIAL;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * The STABLE half of the prompt — brand rules, decision rules, output contract.
 *
 * This is the cached prefix (scope 12.3). Prompt caching is prefix-match: any
 * byte change anywhere in it invalidates everything after. So nothing volatile
 * goes in here — no timestamps, no run ids, no keyword. Those belong in the
 * user turn, after the last cache breakpoint.
 *
 * It must also clear ~1024 tokens or it silently will not cache at all.
 */
export function buildSystemPrefix({ brandVoice, contentType }) {
  return [
    'You write the website and social content for one small business, in its own voice.',
    'You follow a documented keyword-first process.',
    '',
    'NON-NEGOTIABLE RULES:',
    '1. The primary keyword must appear in the title, the first 100 words, at least one',
    '   subheading, and the meta description. This is checked mechanically after you write.',
    '2. Never name a real client, customer, or competitor.',
    '3. Never claim a product feature exists unless it is explicitly listed as shipped.',
    '4. Never write about political, religious, or otherwise divisive topics.',
    '5. Never make a statistical or research claim you cannot attribute.',
    '6. At most one exclamation point in the entire piece.',
    '7. No filler openers ("In today\'s fast-paced world", "In the ever-evolving...").',
    '8. Do not offer legal, medical, tax, or investment advice.',
    '',
    'VOICE:',
    brandVoice || 'Professional, direct, and concrete. Short sentences. No hype.',
    '',
    'You write for a reader who is busy and skeptical. Lead with the useful thing.',
    'Prefer specifics over adjectives. If a sentence could appear on any company\'s',
    'blog, delete it and write one that could only appear on this one.',
    '',
    `CONTENT TYPE: ${contentType}`,
    '',
    'OUTPUT CONTRACT — return a single JSON object and nothing else. No markdown',
    'fences, no commentary before or after:',
    '{',
    '  "title": string,',
    '  "body_markdown": string,',
    ...(contentType === 'social_carousel' ? [
      '  "slides": [{"heading": string (max 10 words, the big statement),',
      '              "body": string (max 30 words, the supporting line)}]',
      '     — 3 to 7 slides; slide 1 is the hook, the last slide is the call to action.',
      '     body_markdown then carries the post CAPTION, not the slide copy,',
    ] : []),
    '  "meta_description": string (150-160 characters),',
    '  "url_slug": string (lowercase, hyphenated, no stop words),',
    '  "cover_image_prompt": string (a prompt for an image generator, describing',
    '     the cover image; reference the brand colours if supplied),',
    '  "confidence_note": string (one sentence: what you were unsure about)',
    '}',
  ].join('\n');
}

/** The VOLATILE half — changes every run, so it lives after the cache breakpoint. */
export function buildUserTurn({ topic, styleContext, shippedFeatures = [], brief = null }) {
  const lines = [
    `PRIMARY KEYWORD: ${topic.keyword}`,
    topic.rationale ? `WHY THIS TOPIC: ${topic.rationale}` : '',
    topic.intent ? `SEARCH INTENT: ${topic.intent}` : '',
    '',
  ];
  if (styleContext) { lines.push(styleContext, ''); }
  if (shippedFeatures.length) {
    lines.push(`FEATURES CONFIRMED IN PRODUCTION (only these may be described as existing): ${shippedFeatures.join(', ')}`, '');
  }
  // What the business told us, from its SAVED Brief answers (never a
  // suggestion it has not looked at). Only answers that are set are listed.
  // The offers line is the campaign agent's own, with the same instruction.
  if (brief) {
    const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
    if (brief.whatWeSell?.length) lines.push(`WHAT THE BUSINESS SELLS: ${list(brief.whatWeSell).join(', ')}`);
    if (brief.whereWeWork?.length) lines.push(`WHERE IT WORKS: ${list(brief.whereWeWork).join(', ')}`);
    lines.push(`APPROVED OFFERS (the only offers you may mention): ${list(brief.approvedOffers).length ? list(brief.approvedOffers).join(' | ') : 'none - do not offer any discount or anything free'}`);
    lines.push("Use an offer's words exactly as written.");
    lines.push(`PROOF YOU MAY QUOTE: ${list(brief.approvedProof).length ? list(brief.approvedProof).join(' | ') : 'none - do not quote a customer, a number or an award'}`);
    if (brief.doNotSay) lines.push(`WORDS NEVER TO USE: ${brief.doNotSay}`);
    if (brief.noGoList) lines.push(`WORK THE BUSINESS DOES NOT TAKE (never offer it): ${brief.noGoList}`);
    lines.push('Never put a price in the piece, and never promise a place on Google.', '');
  }
  lines.push('Write the piece now. Return only the JSON object.');
  return lines.filter((l) => l !== undefined).join('\n');
}

// ---------------------------------------------------------------------------
// Mechanical checks — scope 12.4, failure mode F4
// ---------------------------------------------------------------------------

export const REQUIRED_FIELDS = ['title', 'body_markdown', 'meta_description', 'url_slug'];

export function validateShape(draft) {
  const missing = REQUIRED_FIELDS.filter((f) => !draft || !String(draft[f] || '').trim());
  return { ok: missing.length === 0, missing };
}

/**
 * Keyword placement — SEO Standards 3.2. Purely mechanical, which is why it is
 * checked in code rather than trusted to the model.
 */
export function checkKeywordPlacement(draft, keyword) {
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return { ok: false, missing: ['no keyword supplied'] };

  const title = String(draft.title || '').toLowerCase();
  const body = String(draft.body_markdown || '');
  const meta = String(draft.meta_description || '').toLowerCase();

  const first100 = body.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  const subheads = (body.match(/^#{2,6}\s+.*$/gm) || []).join(' ').toLowerCase();

  const missing = [];
  if (!title.includes(kw)) missing.push('title');
  if (!first100.includes(kw)) missing.push('first 100 words');
  if (!subheads.includes(kw)) missing.push('a subheading');
  if (!meta.includes(kw)) missing.push('meta description');

  return { ok: missing.length === 0, missing };
}

/** Models sometimes wrap JSON in fences despite instructions. Strip, then parse. */
export function parseDraftJson(text) {
  const clean = String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new DraftingError(
      'model returned unparseable JSON',
      'unparseable_output',
      `${err.message}. Head: ${clean.slice(0, 300)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The Anthropic call
// ---------------------------------------------------------------------------

/**
 * One Messages API call, shaped for meterAndAudit's runCall contract.
 *
 * Returns { inputTokens, outputTokens, imageCount, data } so the wrapper can
 * compute a cost basis. Raw fetch rather than the SDK matches this repo's
 * existing convention (lib/aiCopy.js) — the SDK is not a dependency here and
 * adding one to a production API for a single call is not worth the churn.
 */
export async function callClaude({
  systemPrefix, userTurn, model = MODELS.DRAFT,
  maxTokens = DRAFT.MAX_TOKENS, timeoutMs = DRAFT.TIMEOUT_MS,
  apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch,
}) {
  if (!apiKey) throw new DraftingError('ANTHROPIC_API_KEY is not set', 'no_api_key');

  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Cache the stable rules block. cache_control marks the END of the cached
      // prefix, so everything before it is reused across runs and the volatile
      // user turn sits after it.
      system: [{ type: 'text', text: systemPrefix, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userTurn }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // THROW. Do not return a fallback draft — AC4.
    throw new DraftingError(
      `Anthropic HTTP ${res.status}`,
      'provider_error',
      body.slice(0, 300),
    );
  }

  const body = await res.json();

  // Guard the refusal stop reason before reading content.
  if (body?.stop_reason === 'refusal') {
    throw new DraftingError('model refused the request', 'refusal', JSON.stringify(body?.stop_details || {}));
  }

  const text = (body?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text) throw new DraftingError('model returned no text content', 'empty_output');

  return {
    inputTokens: body?.usage?.input_tokens || 0,
    outputTokens: body?.usage?.output_tokens || 0,
    imageCount: 0,
    data: {
      text,
      cacheReadTokens: body?.usage?.cache_read_input_tokens || 0,
      cacheCreationTokens: body?.usage?.cache_creation_input_tokens || 0,
      stopReason: body?.stop_reason,
    },
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Draft one content unit.
 *
 * @throws {DraftingError} on any provider or validation failure — the caller
 *         marks the run failed and queues nothing (AC4).
 * @returns {Promise<{draft, guardrails, attempts, audit, escalated}>}
 */
export async function draftContentUnit({
  pool, tenantId, userId = null, topic, styleProfile = null,
  contentType = 'blog_post', brandVoice = null, shippedFeatures = [],
  protectedClientNames = [], approvedClientNames = [], competitorNames = [],
  breaker, callImpl = callClaude, brief = null,
}) {
  if (!breaker) throw new DraftingError('a RunCostBreaker is required — an unmetered run has no ceiling', 'no_breaker');

  const systemPrefix = buildSystemPrefix({ brandVoice, contentType });
  const styleContext = renderStyleContext(styleProfile);
  const actionType = actionForContentType(contentType);

  let attempts = 0;
  let lastValidationDetail = null;

  // One retry on a MECHANICAL failure only (scope 12.4, F4). Provider failures
  // are not retried here — meterAndAudit's runCall already sits behind the
  // shared client's own retry, and re-rolling a 500 is how a retry storm starts.
  while (attempts <= DRAFT.MAX_VALIDATION_RETRIES) {
    attempts += 1;

    let userTurn = buildUserTurn({ topic, styleContext, shippedFeatures, brief });
    if (lastValidationDetail) {
      userTurn += `\n\nYOUR PREVIOUS ATTEMPT FAILED A MECHANICAL CHECK: ${lastValidationDetail}\nFix exactly that and return the JSON again.`;
    }

    const metered = await spendGuarded(breaker, () => meterAndAudit({
      pool,
      tenantId,
      userId,
      actionType,
      provider: 'anthropic',
      model: MODELS.DRAFT,
      meta: { keyword: topic.keyword, content_type: contentType, attempt: attempts },
      runCall: () => callImpl({ systemPrefix, userTurn }),
    }));

    if (!metered.ok) {
      // insufficient_credits / unknown_action / provider_error all land here.
      throw new DraftingError(
        `metered call failed: ${metered.error?.code}`,
        metered.error?.code || 'metered_call_failed',
        metered.error?.message,
      );
    }

    const draft = parseDraftJson(metered.result?.text);

    const shape = validateShape(draft);
    if (!shape.ok) {
      lastValidationDetail = `missing required field(s): ${shape.missing.join(', ')}`;
      if (attempts > DRAFT.MAX_VALIDATION_RETRIES) {
        throw new DraftingError('draft missing required fields after retry', 'invalid_shape', lastValidationDetail);
      }
      continue;
    }

    // Keyword placement is BLOG semantics (SEO Standards 3.2: title, first 100
    // words, a subheading, the meta description). Social copy has no
    // subheadings or meta to place a keyword in — running the check on a
    // carousel caption F4-skips perfectly good copy for failing rules that
    // don't apply to it. Found on the first live social run, 2026-08-24.
    if (contentType === 'blog_post') {
      const placement = checkKeywordPlacement(draft, topic.keyword);
      if (!placement.ok) {
        lastValidationDetail = `primary keyword "${topic.keyword}" missing from: ${placement.missing.join(', ')}`;
        if (attempts > DRAFT.MAX_VALIDATION_RETRIES) {
          // F4: one retry, then skip the slot and log. Not an error the run dies
          // on — a slot the agent honestly could not fill.
          throw new DraftingError('keyword placement failed after retry', 'keyword_placement', lastValidationDetail);
        }
        continue;
      }
    }

    // Guardrails run on the FINAL text, after all retries. Escalation is not a
    // failure — it is a verdict the caller records and withholds from the queue.
    const guardrails = runGuardrails(draft.body_markdown, {
      contentType, protectedClientNames, approvedClientNames, competitorNames, shippedFeatures,
    });

    return {
      draft,
      guardrails,
      attempts,
      escalated: guardrails.escalate,
      audit: metered.audit,
    };
  }

  throw new DraftingError('exhausted drafting attempts', 'exhausted', lastValidationDetail);
}

/**
 * Persist a drafted unit. Escalated units are stored with review_status
 * 'escalated' so the queue endpoint can withhold them (AC2) while they remain
 * fully auditable.
 */
export async function saveOutput(pool, {
  runId, tenantId, siteId = null, contentType, topic, draft,
  guardrails, styleProfileId = null, jobKey = null, briefCited = null,
}) {
  const r = await pool.request()
    .input('runId', sql.UniqueIdentifier, runId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('contentType', sql.NVarChar(40), contentType)
    .input('keyword', sql.NVarChar(300), topic.keyword)
    .input('volume', sql.Int, topic.volume ?? null)
    .input('kd', sql.Decimal(6, 2), topic.difficulty ?? null)
    .input('intent', sql.NVarChar(40), topic.intent || null)
    .input('rationale', sql.NVarChar(sql.MAX), topic.rationale || null)
    .input('title', sql.NVarChar(500), draft.title)
    .input('body', sql.NVarChar(sql.MAX), draft.body_markdown)
    .input('meta', sql.NVarChar(500), draft.meta_description)
    .input('slug', sql.NVarChar(400), draft.url_slug)
    .input('imgPrompt', sql.NVarChar(sql.MAX), draft.cover_image_prompt || null)
    .input('styleId', sql.UniqueIdentifier, styleProfileId)
    .input('flags', sql.NVarChar(sql.MAX), JSON.stringify(guardrails.escalate ? guardrails.flags : guardrails.failures))
    .input('note', sql.NVarChar(sql.MAX), draft.confidence_note || null)
    .input('review', sql.NVarChar(20), guardrails.escalate ? 'escalated' : 'pending')
    .input('jobKey', sql.NVarChar(80), jobKey)
    .input('cited', sql.NVarChar(sql.MAX), briefCited ? JSON.stringify(briefCited) : null)
    .query(`
      INSERT INTO arion.content_agent_output
        (run_id, tenant_id, site_id, content_type, primary_keyword, keyword_volume,
         keyword_kd, keyword_intent, keyword_rationale, title, body_markdown,
         meta_description, url_slug, cover_image_prompt, style_profile_id,
         decision_rule_flags_json, confidence_note, review_status, job_key, brief_cited_json)
      OUTPUT INSERTED.output_id
      VALUES (@runId, @tenantId, @siteId, @contentType, @keyword, @volume, @kd,
              @intent, @rationale, @title, @body, @meta, @slug, @imgPrompt,
              @styleId, @flags, @note, @review, @jobKey, @cited)`);
  return r.recordset[0].output_id;
}

export default {
  DraftingError, ACTION, actionForContentType, buildSystemPrefix, buildUserTurn,
  REQUIRED_FIELDS, validateShape, checkKeywordPlacement, parseDraftJson,
  callClaude, draftContentUnit, saveOutput, ALLOW_MODEL_FALLBACK,
};
