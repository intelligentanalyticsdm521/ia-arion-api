// test/agent-jobs-contract.test.mjs — T17 (arion-api's half): this repo's copy
// of the shared contract test/fixtures/agent-jobs-contract.json.
//
//   - the copy is byte-identical to platform-api's (its hash is the hash
//     platform-api wrote, copied beside it; line endings normalised so a fresh
//     Windows checkout does not read as a change);
//   - lib/team/jobState.js sends the fixture's statement, word for word;
//   - the three definitions' checksums are computed here the same way
//     (sorted-key JSON, sha256), so the three repos agree on the hex;
//   - the runner_ref <-> job_key map for this repo's jobs.
//
// The offer, proof, hold and ranking lists in the fixture are pinned against
// the runners' own constants by the runner tests (stream 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { JOB_STATE_SQL } from '../lib/team/jobState.js';

const TEXT = fs.readFileSync(new URL('./fixtures/agent-jobs-contract.json', import.meta.url), 'utf8').split('\r\n').join('\n');
const C = JSON.parse(TEXT);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value != null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

test("this copy is platform-api's, byte for byte", () => {
  const want = fs.readFileSync(new URL('./fixtures/agent-jobs-contract.sha256', import.meta.url), 'utf8').trim();
  assert.equal(crypto.createHash('sha256').update(TEXT).digest('hex'), want);
});

test('lib/team/jobState.js sends the fixture statement', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(JOB_STATE_SQL), norm(C.job_state_sql));
});

test('the three definitions have the same checksums here', () => {
  for (const d of C.definitions) assert.equal(crypto.createHash('sha256').update(canonical(d.def)).digest('hex'), d.checksum, d.job_key);
});

test("this repo's jobs and the runners they map to", () => {
  const mine = Object.fromEntries(C.jobs.filter((j) => String(j.runner_ref || '').startsWith('arion:')).map((j) => [j.runner_ref, j.job_key]));
  assert.deepEqual(mine, {
    'arion:content_agent:blog_post': 'arion.blog_posts',
    'arion:content_agent:social_post': 'arion.social_posts',
    'arion:gbp_reply_runner': 'arion.review_replies',
  });
  assert.deepEqual(C.jobs.find((j) => j.job_key === 'arion.review_replies').allowed_actions, ['arion.read_new_reviews', 'arion.draft_review_reply', 'arion.post_review_reply']);
});

test('the stream-1 files in this repo name no business (comments out)', () => {
  const DEFECTS = [/intelligent\s+analytics/i, /intelligentanalyticsdm/i, /ia-dm\.com/i, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, /\bWeb Design\b/, /\bWebsite audit\b/i, /\bwalkthrough\b/i, /\bDes Moines\b/i];
  for (const rel of ['../lib/team/jobState.js', '../lib/team/brief.js']) {
    const code = fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, '$1')).join('\n');
    for (const re of DEFECTS) assert.doesNotMatch(code, re, `${rel}: ${re}`);
  }
});

// platform-api's validator (lib/team/definition.js varProblem) runs the same
// cases in its own copy of this fixture: what the job drawer says was saved is
// what this runner uses. A var with no limits takes no value on either side.
test('varInLimits agrees with the server on every shared var-limit case (test/fixtures/var-limit-cases.json)', async () => {
  const { varInLimits } = await import('../lib/team/jobState.js');
  const at = (name) => new URL(`./fixtures/${name}`, import.meta.url);
  const text = fs.readFileSync(at('var-limit-cases.json'), 'utf8').split('\r\n').join('\n');
  const want = fs.readFileSync(at('var-limit-cases.sha256'), 'utf8').trim();
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), want, "this copy is platform-api's, byte for byte");
  const cases = JSON.parse(text).cases;
  assert.ok(Array.isArray(cases) && cases.length >= 10);
  for (const c of cases) assert.equal(varInLimits(c.spec, c.value), c.ok, `${c.why}: ${JSON.stringify(c)}`);
});
