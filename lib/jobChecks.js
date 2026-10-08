// lib/jobChecks.js — the web person's jobs: what each one may do, the named
// checks it runs on what it wrote, and the sentences an owner reads.
//
// ARGUS employees, phase 1 (overnight-report/CONTRACT_ARGUS_EMPLOYEES_PHASE1_
// 2026-10-08.md §D.2, §D.3, §D.7, §F.1). Every value here is a PLATFORM rule,
// the same for every business: nothing in this file knows a business. What a
// business allows (its offers, its proof, its names, its competitors) arrives
// at run time from its own Business Brief and is passed in as `ctx`.
//
// THE CHECKS ARE CODE, NOT PROMPTS. They run on the text that was written,
// after it was written, and a fired check holds the item for a person. A model
// asked nicely not to put a price in a blog post will comply almost always;
// "almost always" is not a check.
//
// A DECLARED COPY. The regular expressions and word lists are copied from
// LUMEN (chat PRICE_RE, src/services/chatWorkflows/definition.js; campaign
// OFFER_PATTERNS and SOCIAL_PROOF_PATTERNS, src/lib/campaignAgent/guardrails.js;
// the Responder's HOLD_KEYWORDS, src/services/responder/config.js) and the
// shared fixture test/fixtures/agent-jobs-contract.json pins them across the
// three repos. Change them there, in all three, in one commit per repo.
//
// FAIL CLOSED. A playbook that names a check this file does not implement is
// not "run without it": the job does nothing and says so (§D.7 rule 3).

/* ══════════════════════════════════════════════════════════════════════════
   1. The jobs this repo runs
   ══════════════════════════════════════════════════════════════════════════ */

export const JOB = Object.freeze({
  BLOG: 'arion.blog_posts',
  SOCIAL: 'arion.social_posts',
  REVIEWS: 'arion.review_replies',
});
export const CONTENT_JOBS = Object.freeze([JOB.BLOG, JOB.SOCIAL]);
export const EMPLOYEE_KEY = 'web';

/** runner_ref <-> job_key (the shared fixture pins this map). */
export const RUNNER_REF = Object.freeze({
  'arion:content_agent:blog_post': JOB.BLOG,
  'arion:content_agent:social_post': JOB.SOCIAL,
  'arion:gbp_reply_runner': JOB.REVIEWS,
});

/** The content type the content agent writes for each job, and back. */
export const CONTENT_TYPE_FOR_JOB = Object.freeze({ [JOB.BLOG]: 'blog_post', [JOB.SOCIAL]: 'social_post' });
export function jobForContentType(contentType) {
  if (contentType === 'blog_post') return JOB.BLOG;
  // An old carousel is shown under social posts (phase 1 has no carousel job).
  if (contentType === 'social_post' || contentType === 'social_carousel') return JOB.SOCIAL;
  return null;
}

/** What each runner can actually do, in order (§D.2). A pinned playbook must equal it. */
export const SUPPORTED_ACTIONS = Object.freeze({
  [JOB.BLOG]: Object.freeze(['arion.pick_topic', 'arion.draft_blog_post', 'arion.publish_blog_post']),
  [JOB.SOCIAL]: Object.freeze(['arion.pick_topic', 'arion.draft_social_post', 'arion.schedule_social_post']),
  [JOB.REVIEWS]: Object.freeze(['arion.read_new_reviews', 'arion.draft_review_reply', 'arion.post_review_reply']),
});

const CONTENT_CHECKS = Object.freeze(['no_price', 'offers_from_brief_only', 'no_invented_proof',
  'no_names_from_never_name', 'no_competitor_names', 'no_ranking_promise']);

/** The checks a job runs whatever its playbook says (§D.3; added again by the runner, §D.7). */
export const PLATFORM_CHECKS = Object.freeze({
  [JOB.BLOG]: CONTENT_CHECKS,
  [JOB.SOCIAL]: CONTENT_CHECKS,
  [JOB.REVIEWS]: Object.freeze(['no_price', 'offers_from_brief_only', 'no_names_from_never_name',
    'no_competitor_names', 'low_star_review_asks', 'hold_complaint_legal_refund']),
});

/**
 * The checks each runner REALLY runs on what it wrote (§D.7 rule 3). "Known"
 * is per job, never "some runner in this repo has it": a playbook that adds a
 * check this job's runner does not run is refused, not accepted and then
 * silently skipped. A blog post has no star rating, so the low-star hold is a
 * review-reply check only.
 */
export const RUNNABLE_CHECKS = Object.freeze({
  [JOB.BLOG]: Object.freeze([...CONTENT_CHECKS, 'hold_complaint_legal_refund']),
  [JOB.SOCIAL]: Object.freeze([...CONTENT_CHECKS, 'hold_complaint_legal_refund']),
  [JOB.REVIEWS]: Object.freeze([...CONTENT_CHECKS, 'low_star_review_asks', 'hold_complaint_legal_refund']),
});

/** Can THIS job's runner run this check? */
export function runsCheck(jobKey, name) {
  return (RUNNABLE_CHECKS[jobKey] || []).includes(name) && typeof CHECKS[name] === 'function';
}

/** The names in `names` this job's runner cannot run (empty = all fine). */
export function unknownChecksFor(jobKey, names) {
  return (names || []).filter((n) => !runsCheck(jobKey, n));
}

/** "What I never do" (§D.2), one sentence per check in the library. */
export const CHECK_WORDS = Object.freeze({
  no_price: 'Put a price in anything I write. Prices come from your price list, never from me.',
  offers_from_brief_only: "Offer a discount or anything free that isn't in the offers you allow.",
  no_invented_proof: "Quote a customer, a number or an award that isn't in the proof you allow.",
  no_names_from_never_name: 'Name anyone on your list of names never to mention.',
  no_competitor_names: 'Name a competitor.',
  no_ranking_promise: 'Promise a place on Google.',
  low_star_review_asks: 'Answer a review of 3 stars or fewer without you.',
  hold_complaint_legal_refund: 'Answer a complaint, a refund or anything legal without you.',
  over_money_limit_asks: 'Send a quote over your limit without you.',
  no_collections_language: "Threaten, say 'final notice', or use legal words about money.",
});

/** "Why it waited" (§F.1), one sentence each. */
export const HELD_WORDS = Object.freeze({
  send_me_first: 'Your job is set to Send me first.',
  low_star: 'Reviews of 3 stars or fewer always wait for you.',
  not_automatic_stars: 'This review is below the stars you answer by themselves, so it waited.',
  always_asks: 'This job always asks you first.',
  no_price: 'This puts a price in writing.',
  offers_from_brief_only: "This offer isn't in the offers you allow.",
  no_invented_proof: "This quotes proof you haven't allowed.",
  no_names_from_never_name: 'This names someone on your never-mention list.',
  no_competitor_names: 'This names a competitor.',
  no_ranking_promise: 'This promises a place on Google.',
  low_star_review_asks: 'Reviews of 3 stars or fewer always wait for you.',
  hold_complaint_legal_refund: 'This mentions a refund, a complaint or something legal, so I held it.',
  // The content agent's own older holds (lib/contentAgent/guardrails.js ESCALATE).
  held_subject: 'This touches a subject I hold back for you to check.',
  post_failed: "Google didn't take this reply when I tried to post it. Try again.",
  handoff_failed: "This post is approved but didn't reach your social scheduler. Try again.",
  not_published: 'You approved this. It goes on your website when you say.',
  // Why a draft waited when the job is Automatic (it did not wait for the mode).
  quality: "This didn't pass my own quality check, so it waited for you.",
  automatic_failed: "I tried to approve this in advance and it didn't go through, so it waited for you.",
  automatic_publish_failed: "I approved this in advance but your website didn't take it. Try again.",
  automatic_handoff_failed: "I approved this in advance but it didn't reach your social scheduler. Try again.",
  posting_unconfirmed: "I started posting this reply and didn't hear back from Google. Post it again and I'll check Google first.",
});

/** Sentences a runner writes on its run row. */
export const RUN_WORDS = Object.freeze({
  JOB_STATE_UNREADABLE: "ARGUS couldn't check which jobs are switched on, so it did nothing this time.",
  BRIEF_UNREADABLE: "I couldn't read your business details, so I didn't write anything.",
  BRIEF_UNREADABLE_REVIEWS: "I couldn't read your business details, so I didn't answer any reviews.",
  WAITING_FOR_SERVICES: "I'm waiting for you to tell me what you sell (Settings → Your business).",
  STEPS_MISMATCH: "This job's steps don't match what I can do, so I did nothing.",
  unknownCheck: (name) => `ARGUS has no check called ${name}, so I did nothing.`,
  JOB_OFF: (name) => `${name} is off, so I did nothing.`,
});

/* ══════════════════════════════════════════════════════════════════════════
   2. The patterns (declared copies; the shared fixture pins every source)
   ══════════════════════════════════════════════════════════════════════════ */

/** Money in a sentence (LUMEN chat definition.js PRICE_RE, copied). */
export const PRICE_RE = /(\$|£|€)\s?\d|\b\d[\d,.]*\s?(dollars|usd|bucks)\b|\b(costs?|price is|priced at|starts? at)\s+\$?\d/i;

/**
 * An offer or a discount (LUMEN campaign guardrails OFFER_PATTERNS, copied).
 * Wide on purpose: "free" followed by anything except the everyday phrases
 * (feel free to, free up, free time, free from, free and clear), any percent
 * or "percent" off, half price, buy one get one, on the house, complimentary.
 * "Stress-free" and "hassle-free" are not offers (the hyphen guard).
 */
export const OFFER_PATTERNS = Object.freeze([
  /\b\d{1,3}\s?(?:%|percent)\s*off\b/i,
  /(?<![\w-])free\s+(?!(?:to|up|time|from|and|or)\b)[\w][\w-]*/i,
  /\b(?:discount(?:s|ed)?|coupons?|promo codes?|vouchers?)\b/i,
  /\bsave\s+(?:\$\d+|\d{1,3}\s?(?:%|percent))/i,
  /\bno charge\b|\bon the house\b|\bcomplimentary\b/i,
  /\bhalf[\s-](?:price|off)\b/i,
  /\bbuy\s+one,?\s+get\s+one\b|\bbogo\b/i,
]);

/** A quote, a rating or a testimonial (LUMEN campaign SOCIAL_PROOF_PATTERNS, copied). */
export const SOCIAL_PROOF_PATTERNS = Object.freeze([
  /\b(?:one of our (?:customers|clients)|a recent (?:customer|client))\b[^.!?]*\b(?:said|told us|raved|loved)\b/i,
  /["“][^"”]{20,}["”]\s*[-—]\s*(?:a\s)?(?:happy|satisfied|local)\s+(?:customer|client)/i,
  /\b5[- ]star (?:review|rating)s? (?:from|say)\b/i,
]);

/**
 * Words that mean a person answers this one (LUMEN Responder HOLD_KEYWORDS,
 * copied). Matched as WHOLE words or phrases (holdWordHit), never inside
 * another word: "reliable" is not "liable", "courteous" is not "court",
 * "pursuing" is not "suing".
 */
export const HOLD_KEYWORDS = Object.freeze([
  'complaint', 'complain', 'refund', 'money back', 'chargeback',
  'lawyer', 'attorney', 'solicitor', 'legal action', 'sue you', 'suing',
  'small claims', 'court', 'lawsuit', 'liable', 'liability', 'negligent',
  'damaged', 'damage to my', 'injury', 'injured', 'insurance claim',
  'bbb', 'better business bureau', 'consumer protection',
  'cancel my', 'cancel our', 'terrible', 'unacceptable', 'disgrace',
  'never again', 'worst', 'scam', 'fraud', 'ripped me off', 'rip off',
]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `text` hold `keyword` as a whole word or phrase? Nothing may touch its
 * start; its end may carry an ordinary ending (refund-s, complain-ed,
 * scam-m-ed). The shared fixture pins the cases (hold_keyword_cases) in all
 * three repos, so the rule cannot drift.
 */
export function holdWordHit(text, keyword) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k)}(?:\\p{L}?(?:s|es|ed|d|ing|er|ers))?(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(String(text || ''));
}

/** A promised place on Google (§D.2 phrase list). */
export const RANKING_PATTERNS = Object.freeze([
  /number one on google/i,
  /#1 on google/i,
  /first page of google/i,
  /top of google/i,
  /guarantee(d)? (a )?(top )?(ranking|rankings|first page)/i,
  /rank (number one|#?1)/i,
]);

/* ══════════════════════════════════════════════════════════════════════════
   3. Running the checks
   ══════════════════════════════════════════════════════════════════════════ */

const around = (text, index, len) => String(text || '').slice(Math.max(0, index - 60), index + len + 60).trim();

/** A whole-word, case-blind mention of `name` (letters or digits never touch its ends). */
export function mentions(text, name) {
  const clean = String(name || '').trim();
  if (clean.length < 2) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(clean)}(?![\\p{L}\\p{N}])`, 'iu');
  const m = String(text || '').match(re);
  return m ? { match: m[0], index: m.index } : null;
}

function firstHit(text, patterns) {
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (m) return { match: m[0], index: m.index };
  }
  return null;
}

function allHits(text, patterns) {
  const out = [];
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (m) out.push({ match: m[0], index: m.index });
  }
  return out;
}

/** Every match of every pattern (not only the first of each). */
function everyHit(text, patterns) {
  const out = [];
  const body = String(text || '');
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of body.matchAll(g)) out.push({ match: m[0], index: m.index });
  }
  return out;
}

/* ── Proof: the offers rule, for testimonials ─────────────────────────────
   Every match of every proof pattern is judged ON ITS OWN, and a match is
   allowed only when what it CLAIMS lies inside one allowed proof item's own
   words. An allowed quote sitting next to an invented one no longer carries
   it through (the old rule was "an allowed item anywhere in the 60-character
   window", and only the first match of each pattern was looked at).

   What a match claims:
     - a quote with an attribution ("..." - a happy customer): the quoted words;
     - a lead-in ("A recent customer said ...", "5-star reviews from ..."): the
       rest of its sentence after the lead-in verb, or the quoted words in it.
   A claim of fewer than three words is never allowed (nothing to check it
   against). A declared twin of LUMEN src/lib/campaignAgent/guardrails.js.  */

const normWords = (s) => String(s || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const LEAD_VERB = /\b(?:said|says|told us|raved|loved|from|say)\b/gi;
const OPEN_Q = '\u201C';
const CLOSE_Q = '\u201D';

/** End of the sentence that starts at `from` (quote-aware: a period inside quotes does not end it). */
function sentenceEnd(text, from) {
  let inQuote = false;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === OPEN_Q) inQuote = true;
    else if (c === CLOSE_Q) inQuote = false;
    else if (!inQuote && (c === '.' || c === '!' || c === '?')) return i;
  }
  return text.length;
}

/** The quoted segments in `s`. */
function quotedIn(s) {
  return [...String(s).matchAll(/["\u201C]([^"\u201D]+)["\u201D]/g)].map((m) => m[1]);
}

/** What one proof match claims, as a list of claims (each must be allowed). */
export function proofClaims(text, hit, patternIndex) {
  const body = String(text || '');
  if (patternIndex === 1) return quotedIn(hit.match).slice(0, 1);
  LEAD_VERB.lastIndex = hit.index;
  const verb = LEAD_VERB.exec(body);
  const start = verb && verb.index < hit.index + hit.match.length ? verb.index + verb[0].length : hit.index + hit.match.length;
  const rest = body.slice(start, sentenceEnd(body, start));
  const quotes = quotedIn(rest);
  return quotes.length ? quotes : [rest.replace(/^\s*(?:that|how)\b/i, '')];
}

/** Words a claim may carry around an allowed item ('they', 'it best', 'how we'): no more than this. */
export const PROOF_LEAD_SLACK_WORDS = 3;

/**
 * Is this claim one allowed proof item's own words? Either the claim lies
 * inside an allowed item, or it is an allowed item with at most
 * PROOF_LEAD_SLACK_WORDS words around it. Anything more is an addition
 * nobody allowed.
 */
export function proofClaimAllowed(claim, allowed) {
  const c = normWords(claim);
  const cWords = c.split(' ').filter(Boolean).length;
  if (cWords < 3) return false;
  return (allowed || []).some((a) => {
    const w = normWords(a);
    if (w.length <= 3) return false;
    if (` ${w} `.includes(` ${c} `)) return true;
    return ` ${c} `.includes(` ${w} `) && cWords - w.split(' ').length <= PROOF_LEAD_SLACK_WORDS;
  });
}

/** Every proof match that is not allowed (empty = clean). */
export function inventedProof(text, allowed, patterns = SOCIAL_PROOF_PATTERNS) {
  const out = [];
  const body = String(text || '');
  patterns.forEach((re, i) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of body.matchAll(g)) {
      const hit = { match: m[0], index: m.index };
      const claims = proofClaims(body, hit, i);
      if (!claims.length || !claims.every((c) => proofClaimAllowed(c, allowed))) out.push(hit);
    }
  });
  return out;
}

/**
 * The library. Each entry: (text, ctx) -> null | { evidence }.
 *
 * ctx: { approvedOffers: string[], approvedProof: string[], namesNeverMention:
 *        string[], namesYouMayMention: string[], competitors: string[],
 *        stars?: number, reviewText?: string }
 */
export const CHECKS = Object.freeze({
  no_price(text) {
    const m = String(text || '').match(PRICE_RE);
    return m ? { evidence: around(text, m.index, m[0].length) } : null;
  },
  // An offer-shaped phrase is allowed only when it lies INSIDE an occurrence of
  // an allowed offer's own words, and every match is checked (not the first of
  // each pattern): an allowed offer sitting next to an invented one must not
  // carry it through. The same rule as LUMEN's campaign guardrails.
  offers_from_brief_only(text, ctx) {
    const allowed = (ctx.approvedOffers || []).map((o) => String(o).toLowerCase().trim()).filter((o) => o.length > 3);
    const lower = String(text || '').toLowerCase();
    const inside = (hit) => allowed.some((o) => {
      for (let at = lower.indexOf(o); at !== -1; at = lower.indexOf(o, at + 1)) {
        if (hit.index >= at && hit.index + hit.match.length <= at + o.length) return true;
      }
      return false;
    });
    for (const hit of everyHit(text, OFFER_PATTERNS)) {
      if (!inside(hit)) return { evidence: around(text, hit.index, hit.match.length) };
    }
    return null;
  },
  no_invented_proof(text, ctx) {
    const [hit] = inventedProof(text, ctx.approvedProof || []);
    return hit ? { evidence: around(text, hit.index, hit.match.length) } : null;
  },
  no_names_from_never_name(text, ctx) {
    const may = new Set((ctx.namesYouMayMention || []).map((n) => String(n).toLowerCase().trim()));
    for (const name of ctx.namesNeverMention || []) {
      if (may.has(String(name).toLowerCase().trim())) continue;
      const hit = mentions(text, name);
      if (hit) return { evidence: around(text, hit.index, hit.match.length) };
    }
    return null;
  },
  no_competitor_names(text, ctx) {
    for (const name of ctx.competitors || []) {
      const hit = mentions(text, name);
      if (hit) return { evidence: around(text, hit.index, hit.match.length) };
    }
    return null;
  },
  no_ranking_promise(text) {
    const hit = firstHit(text, RANKING_PATTERNS);
    return hit ? { evidence: around(text, hit.index, hit.match.length) } : null;
  },
  low_star_review_asks(_text, ctx) {
    const stars = Number(ctx.stars);
    // No star rating we can read is treated as a low one: fail closed.
    if (!Number.isFinite(stars) || stars <= 3) return { evidence: `${Number.isFinite(stars) ? stars : 'unknown'} stars` };
    return null;
  },
  hold_complaint_legal_refund(text, ctx) {
    const hay = `${ctx.reviewText || ''}\n${text || ''}`;
    const word = HOLD_KEYWORDS.find((k) => holdWordHit(hay, k));
    return word ? { evidence: word } : null;
  },
});

/**
 * Run the named checks on `text`.
 * @returns {{ ok: boolean, unknown: string[], fired: Array<{ check, words, evidence }> }}
 *   ok is false when any name is not in this file's library: the caller must
 *   then do nothing (fail closed), not run the rest.
 */
export function runChecks(text, names, ctx = {}) {
  const unknown = names.filter((n) => typeof CHECKS[n] !== 'function');
  if (unknown.length) return { ok: false, unknown, fired: [] };
  const fired = [];
  for (const name of names) {
    const hit = CHECKS[name](text, ctx);
    if (hit) fired.push({ check: name, words: HELD_WORDS[name] || CHECK_WORDS[name], evidence: hit.evidence });
  }
  return { ok: true, unknown: [], fired };
}

/* ══════════════════════════════════════════════════════════════════════════
   4. Reading a pinned playbook (agent-job/1) the way §D.7 says
   ══════════════════════════════════════════════════════════════════════════ */

const actionSteps = (def) => (Array.isArray(def?.steps) ? def.steps.filter((s) => s && typeof s.action === 'string') : []);
const checkStep = (def) => (Array.isArray(def?.steps) ? def.steps.find((s) => s && Array.isArray(s.checks)) : null);

/** Rule 1: the pinned steps must equal what this runner can do. */
export function conforms(def, jobKey) {
  const want = SUPPORTED_ACTIONS[jobKey];
  const got = actionSteps(def).map((s) => s.action);
  return !!want && got.length === want.length && got.every((a, i) => a === want[i]);
}

/** Rule 3: the playbook's checks ∪ the platform's for this job. */
export function checksFor(def, jobKey) {
  const own = checkStep(def)?.checks || [];
  return [...new Set([...(PLATFORM_CHECKS[jobKey] || []), ...own.map(String)])];
}

/** Rule 4: 'always' makes every output wait, whatever the mode. Anything unreadable is 'always'. */
export function lastHold(def) {
  const steps = actionSteps(def);
  const hold = steps.length ? steps[steps.length - 1].hold : null;
  return hold === 'by_mode' ? 'by_mode' : 'always';
}

/** Rule 5: the Brief fields a playbook reads, as api names. */
export function readsOf(def) {
  return (Array.isArray(def?.reads) ? def.reads : [])
    .map((r) => String(r))
    .filter((r) => r.startsWith('brief.'))
    .map((r) => r.slice('brief.'.length));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. The Brief, saved answers only
   ══════════════════════════════════════════════════════════════════════════ */

/** The saved value of one answer, or null when it is not set. Never guessed. */
export function briefValue(brief, api) {
  if (!brief) return null;
  if (api === 'businessName') return brief.borrowed?.businessName ?? null;
  const f = brief.fields?.[api];
  return f && f.set === true ? f.value : null;
}

const asList = (v) => (Array.isArray(v) ? v : []);
const words = (item) => (item && typeof item === 'object' ? (item.words ?? item.name ?? '') : item);
const textList = (v) => asList(v).map(words).map((s) => String(s ?? '').trim()).filter(Boolean);

/** The service names in `services` (each entry's `name`, or the string). */
export function serviceNames(brief) {
  return textList(briefValue(brief, 'services'));
}

/** The town names in `serviceArea` ({ cities: [...] } or a list). */
export function serviceTowns(brief) {
  const a = briefValue(brief, 'serviceArea');
  if (!a) return [];
  if (Array.isArray(a)) return textList(a);
  return textList(a.cities);
}

/** The lists a check reads, from the Brief's saved answers. */
export function checkContext(brief, extra = {}) {
  return {
    approvedOffers: textList(briefValue(brief, 'offersAllowed')),
    approvedProof: textList(briefValue(brief, 'proofAllowed')),
    namesNeverMention: textList(briefValue(brief, 'namesNeverMention')),
    namesYouMayMention: textList(briefValue(brief, 'namesYouMayMention')),
    competitors: textList(briefValue(brief, 'competitors')),
    ...extra,
  };
}

/** Do the saved answers meet `required_brief` ("services|servicesSummary" = one of)? */
export function briefMeets(brief, required = []) {
  return required.every((req) => String(req).split('|').some((api) => {
    const v = briefValue(brief, api);
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim().length > 0;
  }));
}

/** The citation stored on each output (§E.4): only listed fields that are set. */
export function briefCitation(brief, reads) {
  return {
    version: Number(brief?.version) || 0,
    saved_at: brief?.saved_at || null,
    used: reads.filter((api) => briefValue(brief, api) != null),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   6. The standing approval
   ══════════════════════════════════════════════════════════════════════════ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Oct 2026", from the stored instant, in UTC (the clock the row was written on). */
export function dayWords(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The mode a job really runs in. Automatic needs a recorded approver: an
 * Automatic setting with nobody named is read as Send me first (fail closed).
 */
export function effectiveMode(jobState) {
  return jobState?.mode === 'automatic' && String(jobState.modeSetBy || '').trim() ? 'automatic' : 'review';
}

/** "Approved in advance by Dana Ruiz on 8 Oct 2026". */
export function approvedInAdvanceWords(jobState) {
  const who = String(jobState?.modeSetBy || '').trim();
  const when = dayWords(jobState?.modeSetAt);
  return `Approved in advance by ${who}${when ? ` on ${when}` : ''}`;
}

export default {
  JOB, CONTENT_JOBS, EMPLOYEE_KEY, RUNNER_REF, CONTENT_TYPE_FOR_JOB, jobForContentType,
  SUPPORTED_ACTIONS, PLATFORM_CHECKS, RUNNABLE_CHECKS, runsCheck, unknownChecksFor, CHECK_WORDS, HELD_WORDS, RUN_WORDS,
  PRICE_RE, OFFER_PATTERNS, SOCIAL_PROOF_PATTERNS, HOLD_KEYWORDS, RANKING_PATTERNS,
  holdWordHit, proofClaims, proofClaimAllowed, inventedProof,
  CHECKS, runChecks, mentions, conforms, checksFor, lastHold, readsOf,
  briefValue, serviceNames, serviceTowns, checkContext, briefMeets, briefCitation,
  dayWords, effectiveMode, approvedInAdvanceWords,
};
