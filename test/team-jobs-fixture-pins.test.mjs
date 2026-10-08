// test/team-jobs-fixture-pins.test.mjs — the web person's runners hold the
// SAME rules as the shared contract (test/fixtures/agent-jobs-contract.json,
// written once in platform-api and copied here byte for byte; §H.2).
//
// lib/jobChecks.js is a declared copy: these tests are what make "change
// them there, in all three, in one commit per repo" true. A rule changed in
// one place only goes red here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PRICE_RE, OFFER_PATTERNS, SOCIAL_PROOF_PATTERNS, HOLD_KEYWORDS, RANKING_PATTERNS,
  CHECK_WORDS, SUPPORTED_ACTIONS, PLATFORM_CHECKS, RUNNER_REF, CHECKS,
  PROOF_LEAD_IN_WORDS, PROOF_LEAD_SLACK_WORDS, PROOF_SUBJECTS, PROOF_VERBS, PROOF_CLAIM_WORDS,
  PROOF_FOLLOW_ON_SUBJECTS, PROOF_FOLLOW_ON_PHRASES,
} from '../lib/jobChecks.js';
import { REQUIRED_BRIEF } from '../lib/contentAgent/tick.js';

const C = JSON.parse(fs.readFileSync(new URL('./fixtures/agent-jobs-contract.json', import.meta.url), 'utf8'));
const re = (r) => ({ source: r.source, flags: r.flags });
const MINE = C.jobs.filter((j) => String(j.runner_ref || '').startsWith('arion:'));

test('PRICE_RE is the fixture\'s, source and flags', () => {
  assert.deepEqual(re(PRICE_RE), C.price_re);
});

test('the offer, proof and ranking patterns are the fixture\'s, in order', () => {
  assert.deepEqual(OFFER_PATTERNS.map(re), C.offer_patterns);
  assert.deepEqual(SOCIAL_PROOF_PATTERNS.map(re), C.social_proof_patterns);
  assert.deepEqual(RANKING_PATTERNS.map(re), C.ranking_phrases);
});

test('the hold keywords are the fixture\'s', () => {
  assert.deepEqual([...HOLD_KEYWORDS], C.hold_keywords);
});

test('the proof lead-in words and their limit are the fixture\'s', () => {
  assert.deepEqual([...PROOF_LEAD_IN_WORDS], C.proof_lead_in_words);
  assert.match(C.proof_rule, new RegExp(`up to ${PROOF_LEAD_SLACK_WORDS} lead-in words`));
});

test('the proof subjects, their verbs and the claim words a name may not hold are the fixture\'s', () => {
  assert.deepEqual([...PROOF_SUBJECTS], C.proof_subjects);
  assert.deepEqual([...PROOF_VERBS], C.proof_verbs);
  assert.deepEqual([...PROOF_CLAIM_WORDS], C.proof_claim_words);
});

test('the words that start a follow-on sentence, and its claim phrases, are the fixture\'s', () => {
  assert.deepEqual([...PROOF_FOLLOW_ON_SUBJECTS], C.proof_follow_on_subjects);
  assert.deepEqual([...PROOF_FOLLOW_ON_PHRASES], C.proof_follow_on_phrases);
});

test('"What I never do" is the fixture\'s sentence for every check in the library', () => {
  assert.deepEqual({ ...CHECK_WORDS }, C.checks);
});

test('runner_ref <-> job_key, the steps each runner can do, its platform checks and its required answers', () => {
  assert.deepEqual(Object.fromEntries(MINE.map((j) => [j.runner_ref, j.job_key])), { ...RUNNER_REF });
  for (const j of MINE) {
    assert.deepEqual([...SUPPORTED_ACTIONS[j.job_key]], j.allowed_actions, `${j.job_key} actions`);
    assert.deepEqual([...PLATFORM_CHECKS[j.job_key]], j.platform_checks, `${j.job_key} checks`);
    assert.deepEqual([...(REQUIRED_BRIEF[j.job_key] || [])], j.required_brief, `${j.job_key} required answers`);
  }
});

test('every platform check of these jobs is one this repo can run', () => {
  for (const j of MINE) for (const c of j.platform_checks) assert.equal(typeof CHECKS[c], 'function', `${j.job_key}: ${c}`);
});
