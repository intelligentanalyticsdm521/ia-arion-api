// test/content-agent-guardrails.test.js
//
// Task 4 — Decision Rules 21.3 and 21.6.
//
// These tests are the reason the rules are code rather than prompt text. A
// system-prompt instruction cannot be unit tested; a matcher can, and the
// scope's measurable outcome 4 asks for ZERO false negatives on escalation.
//
// So the bias is asymmetric on purpose and asserted as such: a false positive
// costs Brandon ten seconds of reading, a false negative puts a client's name
// or a political take on the public internet under IA's byline.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkQuality, checkEscalation, runGuardrails,
  QUALITY_FAIL, ESCALATE, MAX_EXCLAMATIONS,
} from '../lib/contentAgent/guardrails.js';

// 50 repeats = 350 words, clearing the 300-word blog-post floor. Sized
// deliberately: at 30 repeats this fixture was 210 words and every "clean copy
// passes" assertion failed on TOO_SHORT, masking what those tests actually check.
const clean = (extra = '') => `${'A genuinely useful sentence about drain maintenance. '.repeat(50)}${extra}`;

// --- 21.3 quality -----------------------------------------------------------

test('auto-fail phrases are caught with surrounding evidence', () => {
  const r = checkQuality(clean('In today\'s fast-paced world, plumbing matters.'));
  const f = r.failures.find((x) => x.rule === QUALITY_FAIL.AUTO_FAIL_PHRASE);
  assert.ok(f, 'the phrase must be caught');
  assert.equal(r.pass, false);
  assert.ok(f.evidence && f.evidence.length > 0, 'evidence must be captured so a human can judge quickly');
});

test('exclamation points beyond the cap fail', () => {
  assert.equal(checkQuality(clean('Great!')).pass, true, `${MAX_EXCLAMATIONS} is allowed`);
  const r = checkQuality(clean('Great! Amazing! Wow!'));
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.rule === QUALITY_FAIL.EXCESS_EXCLAMATION));
});

test('unsourced claims fail — including bare percentage statistics', () => {
  assert.ok(checkQuality(clean('Studies show that gutters matter.')).failures
    .some((f) => f.rule === QUALITY_FAIL.UNSOURCED_CLAIM));
  assert.ok(checkQuality(clean('73% of businesses neglect this.')).failures
    .some((f) => f.rule === QUALITY_FAIL.UNSOURCED_CLAIM),
  'a naked statistic is the most common form of this, and must not slip through');
});

test('the word floor applies to blog posts but not to social copy', () => {
  const short = 'Short but punchy social caption about drains.';
  assert.ok(checkQuality(short, { contentType: 'blog_post' }).failures
    .some((f) => f.rule === QUALITY_FAIL.TOO_SHORT));
  assert.equal(checkQuality(short, { contentType: 'social_post' }).pass, true,
    'social copy is short by nature — the floor would reject every valid caption');
});

test('genuinely good copy passes cleanly', () => {
  const r = checkQuality(clean());
  assert.equal(r.pass, true, `expected a pass, got: ${JSON.stringify(r.failures)}`);
});

// --- 21.6 escalation: real clients ------------------------------------------

test('naming a real client without written approval escalates', () => {
  const r = checkEscalation('We helped Rolling In It double their bookings.', {
    protectedClientNames: ['Rolling In It', 'Briarwood Smiles'],
  });
  assert.equal(r.escalate, true);
  assert.equal(r.flags[0].rule, ESCALATE.CLIENT_NAMED);
  assert.match(r.flags[0].detail, /Rolling In It/);
});

test('an explicitly approved client may be named', () => {
  const r = checkEscalation('We helped Rolling In It double their bookings.', {
    protectedClientNames: ['Rolling In It'],
    approvedClientNames: ['Rolling In It'],
  });
  assert.equal(r.escalate, false, 'written approval is the documented exception');
});

test('client matching is word-bounded — no false positives on substrings', () => {
  const r = checkEscalation('Our briarwoodsmiles-style approach to dental SEO.', {
    protectedClientNames: ['Briarwood'],
  });
  assert.equal(r.escalate, false, 'a substring inside another word is not naming the client');
});

// --- 21.6 escalation: competitors -------------------------------------------

test('a competitor named WITH critical language escalates (Scenario 2)', () => {
  const r = checkEscalation('Unlike Acme Digital, whose recent outage left clients stranded, we stay up.', {
    competitorNames: ['Acme Digital'],
  });
  assert.equal(r.escalate, true);
  assert.equal(r.flags[0].rule, ESCALATE.COMPETITOR_CRITICISED);
});

test('a competitor named neutrally does NOT escalate', () => {
  const r = checkEscalation('Tools like Acme Digital and others serve a similar market.', {
    competitorNames: ['Acme Digital'],
  });
  assert.equal(r.escalate, false,
    'mentioning a competitor is normal; Rule 21.6 is about criticising one without basis');
});

// --- 21.6 escalation: divisive ----------------------------------------------

test('political and religious subject matter escalates', () => {
  for (const s of [
    'What the upcoming election means for small business.',
    'A Christian approach to business ethics.',
    'Our take on immigration policy and hiring.',
  ]) {
    const r = checkEscalation(s);
    assert.equal(r.escalate, true, `should escalate: ${s}`);
    assert.equal(r.flags[0].rule, ESCALATE.DIVISIVE_TOPIC);
  }
});

test('ordinary business content does not trip the divisive matcher', () => {
  const r = checkEscalation('Seasonal gutter maintenance keeps water away from your foundation.');
  assert.equal(r.escalate, false);
});

// --- 21.6 escalation: unshipped features ------------------------------------

test('promissory language about an unshipped feature escalates', () => {
  const r = checkEscalation('Our new analytics dashboard is coming soon to every plan.', { shippedFeatures: [] });
  assert.equal(r.escalate, true);
  assert.equal(r.flags[0].rule, ESCALATE.UNSHIPPED_FEATURE);
});

test('promissory phrasing about something already shipped does not escalate', () => {
  const r = checkEscalation('We are working on expanding the SEO dashboard that already ships today.', {
    shippedFeatures: ['SEO dashboard'],
  });
  assert.equal(r.escalate, false, 'describing real, shipped work is not a false claim');
});

// --- 21.6 escalation: regulated advice --------------------------------------

test('regulated advice escalates', () => {
  assert.equal(checkEscalation('This is not legal advice, but you should sue.').escalate, true);
  assert.equal(checkEscalation('A guaranteed return on your ad spend.').escalate, true);
});

// --- precedence -------------------------------------------------------------

test('escalation dominates quality — an escalated unit is not sent for regeneration', () => {
  // Text that trips BOTH: a political topic and an auto-fail phrase.
  const r = runGuardrails('In today\'s fast-paced world, the election changes everything!!!');
  assert.equal(r.verdict, 'escalate');
  assert.equal(r.escalate, true);
  assert.equal(r.qualityPass, null,
    'quality must not even be evaluated — this unit goes to a human, not back to the model');
  assert.equal(r.failures.length, 0);
});

test('a clean unit returns a pass verdict', () => {
  const r = runGuardrails(clean(), { protectedClientNames: ['Rolling In It'] });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.escalate, false);
  assert.equal(r.qualityPass, true);
});

test('quality failure alone is quality_fail, not escalate — it is regenerable', () => {
  const r = runGuardrails(clean('Unlock the power of drains.'));
  assert.equal(r.verdict, 'quality_fail');
  assert.equal(r.escalate, false, 'a filler phrase is fixable by the model; it is not Brandon\'s problem');
});

// --- the asymmetry, stated as a test ---------------------------------------

test('the matcher errs toward escalating when a signal is ambiguous', () => {
  // "failed" is critical language; paired with a competitor name it escalates
  // even though the sentence might be innocuous in context. That is the
  // intended trade: zero false negatives is the acceptance criterion.
  const r = checkEscalation('Acme Digital failed to respond to our integration request.', {
    competitorNames: ['Acme Digital'],
  });
  assert.equal(r.escalate, true,
    'ambiguous-but-critical about a named competitor must reach a human, per measurable outcome 4');
});
