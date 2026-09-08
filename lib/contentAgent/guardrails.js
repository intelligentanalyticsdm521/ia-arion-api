// lib/contentAgent/guardrails.js
//
// Task 4 — the Decision Rules for Agents, as code.
//
// Scope design principle 2: these are "hard-coded guardrails, not prompted
// suggestions". That distinction is the whole point of this module. A model
// asked nicely in a system prompt not to name a client will comply almost
// always, and "almost always" is not a guardrail — it is a probability. These
// run on the produced text, after generation, and their verdict is not
// something the model can talk its way past.
//
// TWO RULES, DIFFERENT CONSEQUENCES
//
//   21.3 QUALITY  -> auto-fail. Fixable by regeneration. Not Brandon's problem.
//   21.6 ESCALATE -> stop. Do not draft further, do not queue as ready. Flag it
//                    and wait for a human (AC2).
//
// BIAS: toward escalating. Measurable outcome 4 in the scope demands "zero
// false negatives" on escalation — nothing escalation-worthy may ship
// unreviewed. A false positive costs Brandon ten seconds of reading. A false
// negative puts a real client's name, or a divisive take, on the public
// internet under IA's byline. Those are not symmetric, so the matchers are
// deliberately broad and the tests pin that broadness in place.

// ---------------------------------------------------------------------------
// Rule 21.3 — content quality auto-fail
// ---------------------------------------------------------------------------

/** Phrases that mark generic AI filler. Scope 3.3: output must read as Brandon. */
export const AUTO_FAIL_PHRASES = [
  'in today\'s fast-paced world',
  'in the ever-evolving',
  'in the digital age',
  'unlock the power',
  'unleash the power',
  'game-changer',
  'game changer',
  'take your business to the next level',
  'look no further',
  'delve into',
  'it\'s important to note that',
  'in conclusion,',
  'when it comes to',
  'navigating the complexities',
  'in this comprehensive guide',
  'revolutionize',
  'cutting-edge solution',
  'seamlessly integrate',
  'robust solution',
  'leverage the power',
  'harness the power',
  'elevate your',
  'supercharge your',
];

/**
 * Claims that assert a fact without attribution. "Studies show", "research
 * proves", a bare statistic — each is a credibility liability in content that
 * carries a consulting firm's name.
 */
export const UNSOURCED_CLAIM_PATTERNS = [
  /\bstudies (?:show|prove|indicate|confirm)\b/i,
  /\bresearch (?:shows|proves|indicates|confirms)\b/i,
  /\bexperts? (?:agree|say|confirm)\b/i,
  /\bstatistics show\b/i,
  /\bit(?:'s| is) (?:well[- ]known|proven) that\b/i,
  /\b\d{1,3}%\s+of\s+(?:businesses|companies|customers|users|people|marketers)\b/i,
  /\b(?:most|majority of)\s+(?:businesses|companies|experts)\s+(?:agree|say|report)\b/i,
];

/** Max exclamation points tolerated in a whole unit. Brand voice is measured. */
export const MAX_EXCLAMATIONS = 1;

export const QUALITY_FAIL = {
  AUTO_FAIL_PHRASE: 'auto_fail_phrase',
  EXCESS_EXCLAMATION: 'excess_exclamation',
  UNSOURCED_CLAIM: 'unsourced_claim',
  TOO_SHORT: 'too_short',
};

/**
 * Rule 21.3. Pure, no I/O.
 * @returns {{pass: boolean, failures: Array<{rule, detail, evidence}>}}
 */
export function checkQuality(text, { minWords = 300, contentType = 'blog_post' } = {}) {
  const failures = [];
  const body = String(text || '');
  const lower = body.toLowerCase();

  for (const phrase of AUTO_FAIL_PHRASES) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (at !== -1) {
      failures.push({
        rule: QUALITY_FAIL.AUTO_FAIL_PHRASE,
        detail: `contains auto-fail phrase "${phrase}"`,
        evidence: body.slice(Math.max(0, at - 40), at + phrase.length + 40).trim(),
      });
    }
  }

  const exclamations = (body.match(/!/g) || []).length;
  if (exclamations > MAX_EXCLAMATIONS) {
    failures.push({
      rule: QUALITY_FAIL.EXCESS_EXCLAMATION,
      detail: `${exclamations} exclamation points (max ${MAX_EXCLAMATIONS})`,
      evidence: null,
    });
  }

  for (const re of UNSOURCED_CLAIM_PATTERNS) {
    const m = body.match(re);
    if (m) {
      failures.push({
        rule: QUALITY_FAIL.UNSOURCED_CLAIM,
        detail: `unsourced claim: "${m[0]}"`,
        evidence: body.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).trim(),
      });
    }
  }

  // Social copy is short by nature; only long-form has a floor.
  if (contentType === 'blog_post') {
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    if (words < minWords) {
      failures.push({
        rule: QUALITY_FAIL.TOO_SHORT,
        detail: `${words} words, below the ${minWords}-word floor`,
        evidence: null,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Rule 21.6 — escalation
// ---------------------------------------------------------------------------

export const ESCALATE = {
  CLIENT_NAMED: 'real_client_named_without_approval',
  COMPETITOR_CRITICISED: 'competitor_named_critically',
  DIVISIVE_TOPIC: 'divisive_topic',
  UNSHIPPED_FEATURE: 'claims_unshipped_feature',
  LEGAL_MEDICAL_FINANCIAL: 'regulated_advice',
};

/**
 * Political / religious / otherwise divisive. Scope 12.10: the agent "cannot
 * generate content on political, religious, or otherwise divisive topics — it
 * escalates instead."
 *
 * Word-boundary anchored so "electionering" style substrings and innocent
 * compounds do not fire, but deliberately broad on the terms themselves.
 */
export const DIVISIVE_PATTERNS = [
  /\b(?:abortion|pro-life|pro-choice)\b/i,
  /\b(?:democrat|republican|gop|maga|liberal|conservative)s?\b/i,
  /\b(?:election|ballot|voting rights|gerrymander\w*)\b/i,
  /\b(?:immigration|deportation|border wall)\b/i,
  /\b(?:gun control|second amendment|firearms? ban)\b/i,
  /\b(?:climate (?:hoax|denial)|climate change debate)\b/i,
  /\b(?:vaccine mandate|anti-vax\w*)\b/i,
  /\b(?:religio\w+|christian|muslim|islam|jewish|judaism|atheis\w+)\b/i,
  /\b(?:transgender|lgbtq|same-sex marriage)\b/i,
  /\b(?:black lives matter|blm|critical race theory|defund the police)\b/i,
  /\b(?:israel|palestin\w+|gaza|ukraine war)\b/i,
];

/** Regulated advice IA is not licensed to give. */
export const REGULATED_ADVICE_PATTERNS = [
  /\byou should (?:invest|buy stock|sue|file suit)\b/i,
  /\b(?:legal|medical|tax|investment) advice\b/i,
  /\b(?:diagnos\w+|treat\w*) (?:your|a) (?:condition|illness|disease)\b/i,
  /\bguaranteed (?:return|profit|roi)\b/i,
];

/** Language that criticises a named party. Paired with a competitor mention. */
export const CRITICAL_LANGUAGE = [
  /\b(?:scam|fraud|ripoff|rip-off|shady|dishonest|incompetent)\b/i,
  /\b(?:failed|failing|collapse[sd]?|disaster|debacle)\b/i,
  /\b(?:overpriced|overcharges?|gouging)\b/i,
  /\b(?:worse than|inferior to|can't compete|falls short)\b/i,
  /\b(?:lawsuit|sued|investigation|breach|outage)\b/i,
  /\bdon'?t (?:use|trust|hire)\b/i,
];

/** Promising something that is not in production. Scope 12.10. */
export const PROMISSORY_PATTERNS = [
  /\b(?:coming soon|launching soon|will soon (?:be able to|support|offer))\b/i,
  /\b(?:in the coming (?:weeks|months)|later this (?:year|quarter))\b/i,
  /\bwe(?:'| a)re (?:building|developing|working on)\b/i,
  /\b(?:soon you(?:'ll| will) be able to|shortly we(?:'ll| will))\b/i,
];

function findAll(text, patterns) {
  const hits = [];
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (m) hits.push({ match: m[0], index: m.index });
  }
  return hits;
}

function context(text, index, len) {
  const body = String(text || '');
  return body.slice(Math.max(0, index - 60), index + len + 60).trim();
}

/**
 * Rule 21.6. Pure, no I/O — the caller supplies the tenant-scoped name lists,
 * so this module never queries and never sees another tenant's data.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string[]} [ctx.protectedClientNames] real client names for THIS tenant
 * @param {string[]} [ctx.approvedClientNames]  clients with written approval to name
 * @param {string[]} [ctx.competitorNames]
 * @param {string[]} [ctx.shippedFeatures]      features that exist in production
 * @returns {{escalate: boolean, flags: Array<{rule, detail, evidence}>}}
 */
export function checkEscalation(text, {
  protectedClientNames = [], approvedClientNames = [],
  competitorNames = [], shippedFeatures = [],
} = {}) {
  const flags = [];
  const body = String(text || '');
  const approved = new Set(approvedClientNames.map((n) => String(n).toLowerCase().trim()));

  // --- real client named without written approval --------------------------
  for (const name of protectedClientNames) {
    const clean = String(name || '').trim();
    if (clean.length < 3) continue;               // too short to match safely
    if (approved.has(clean.toLowerCase())) continue;
    const re = new RegExp(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = body.match(re);
    if (m) {
      flags.push({
        rule: ESCALATE.CLIENT_NAMED,
        detail: `names real client "${clean}" without confirmed written approval`,
        evidence: context(body, m.index, m[0].length),
      });
    }
  }

  // --- competitor named critically -----------------------------------------
  // Scenario 2 in the scope: a trending keyword tied to a competitor's public
  // issue. The name alone is fine; name PLUS critical language escalates.
  const criticalHits = findAll(body, CRITICAL_LANGUAGE);
  if (criticalHits.length) {
    for (const name of competitorNames) {
      const clean = String(name || '').trim();
      if (clean.length < 3) continue;
      const re = new RegExp(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = body.match(re);
      if (m) {
        flags.push({
          rule: ESCALATE.COMPETITOR_CRITICISED,
          detail: `names competitor "${clean}" alongside critical language ("${criticalHits[0].match}") with no confirmed factual basis`,
          evidence: context(body, m.index, m[0].length),
        });
      }
    }
  }

  // --- divisive topics ------------------------------------------------------
  for (const hit of findAll(body, DIVISIVE_PATTERNS)) {
    flags.push({
      rule: ESCALATE.DIVISIVE_TOPIC,
      detail: `divisive subject matter: "${hit.match}"`,
      evidence: context(body, hit.index, hit.match.length),
    });
  }

  // --- regulated advice -----------------------------------------------------
  for (const hit of findAll(body, REGULATED_ADVICE_PATTERNS)) {
    flags.push({
      rule: ESCALATE.LEGAL_MEDICAL_FINANCIAL,
      detail: `reads as regulated advice: "${hit.match}"`,
      evidence: context(body, hit.index, hit.match.length),
    });
  }

  // --- promising unshipped features ----------------------------------------
  const shipped = new Set(shippedFeatures.map((f) => String(f).toLowerCase().trim()));
  for (const hit of findAll(body, PROMISSORY_PATTERNS)) {
    const window = context(body, hit.index, hit.match.length).toLowerCase();
    // If the sentence names something already in production, promissory phrasing
    // is describing a real thing and is not a false claim.
    const namesShipped = [...shipped].some((f) => f.length > 2 && window.includes(f));
    if (!namesShipped) {
      flags.push({
        rule: ESCALATE.UNSHIPPED_FEATURE,
        detail: `promissory language "${hit.match}" not tied to a feature confirmed in production`,
        evidence: context(body, hit.index, hit.match.length),
      });
    }
  }

  return { escalate: flags.length > 0, flags };
}

/**
 * Run both rules. This is the single call the drafting pipeline makes.
 *
 * Escalation dominates: if a unit escalates, its quality verdict is irrelevant
 * because it is not going to be regenerated — it is going to a human.
 */
export function runGuardrails(text, ctx = {}) {
  const escalation = checkEscalation(text, ctx);
  if (escalation.escalate) {
    return {
      verdict: 'escalate',
      escalate: true,
      qualityPass: null,               // deliberately not evaluated
      flags: escalation.flags,
      failures: [],
    };
  }
  const quality = checkQuality(text, ctx);
  return {
    verdict: quality.pass ? 'pass' : 'quality_fail',
    escalate: false,
    qualityPass: quality.pass,
    flags: [],
    failures: quality.failures,
  };
}

export default {
  AUTO_FAIL_PHRASES, UNSOURCED_CLAIM_PATTERNS, MAX_EXCLAMATIONS,
  QUALITY_FAIL, ESCALATE, DIVISIVE_PATTERNS, REGULATED_ADVICE_PATTERNS,
  CRITICAL_LANGUAGE, PROMISSORY_PATTERNS,
  checkQuality, checkEscalation, runGuardrails,
};
