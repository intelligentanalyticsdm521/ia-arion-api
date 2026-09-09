/**
 * Pre-walk pass 3 — the two content-agent verifiers, which walk rows CA1, CA5
 * and AP33 tell Brandon to run, and which had turned destructive on the merged
 * release line.
 *
 * THE ONE THAT MATTERED. `_dev_verify_content_agent.mjs` borrows the three
 * ARION agent prices out of the legacy pricing home into the consolidated one
 * for the length of its run, and then handed them back with an unconditional
 *
 *     DELETE FROM argus.action_pricing WHERE action_type IN (…the three…)
 *
 * That was correct while the consolidated table had never held them. LUMEN
 * migration 174 (ARGUS pack 1, merged 2026-09-08) now seeds them there
 * PERMANENTLY, so the delete took away rows the script never inserted. Measured
 * on the dev database on 2026-09-09: running CA1 twice left argus.action_pricing
 * holding 3 of the 6 agent actions, which is exactly the fault — "every AI call
 * the agent makes is refused before it starts" — that 174 exists to fix. Walking
 * the walk broke the thing the walk is for, silently, and the next reader would
 * have seen an agent that produced nothing.
 *
 * The rest are the same shape: assertions and cleanup written when this database
 * had ONE business on the content agent and three drafts in the queue. ARGUS
 * pack 1 added the IA POC fixture business, so a cleanup scoped to one tenant
 * left the other's run rows behind for ever, a learned-voice row was written and
 * never removed (which then told `_dev_verify_content_agent_routes.mjs` that the
 * agent had learned a voice nobody taught it), and three counts typed into the
 * files reported rows left behind when there were none.
 *
 * These are source pins, in the idiom of test/prewalk-1b-arion.test.mjs: the
 * scripts call main() at import, so they cannot be loaded into a test process.
 * Every assertion below was mutation-tested by putting the old line back and
 * watching it go red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').split(CRLF).join(LF);

const CYCLE = 'scripts/_dev_verify_content_agent.mjs';
const ROUTES = 'scripts/_dev_verify_content_agent_routes.mjs';

/** The body of a top-level `async function <name>(…) { … }`, braces balanced. */
function bodyOf(text, name) {
  const start = text.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is gone from the script`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`${name} never closes`);
}

/* ── 1. the cleanup gives back only what it borrowed ────────────────────── */

test('returnPricing deletes only the prices this script inserted', () => {
  const text = src(CYCLE);
  const body = bodyOf(text, 'returnPricing');

  // The DELETE must be narrowed by the borrowed set. AGENT_ACTIONS is every
  // price the agent uses, borrowed or not, and naming it here is the bug.
  assert.match(body, /borrowedActions/,
    'returnPricing must delete the borrowed set, not a constant list of every agent action');
  assert.doesNotMatch(body, /AGENT_ACTIONS/,
    'returnPricing named AGENT_ACTIONS again — that deletes rows LUMEN 174 seeded and kills the agent');

  // And it must be able to do nothing at all: on a database where 174 has run,
  // nothing is borrowed and nothing may be deleted.
  assert.match(body, /borrowedActions\.length === 0[\s\S]{0,40}return/,
    'returnPricing must return early when nothing was borrowed');
});

test('borrowPricing works out what is missing before it inserts anything', () => {
  const body = bodyOf(src(CYCLE), 'borrowPricing');
  assert.match(body, /pricingState\(pool\)/,
    'borrowPricing must read what argus.action_pricing already holds');
  assert.match(body, /borrowedActions = AGENT_ACTIONS\.filter/,
    'borrowPricing must record which actions it is actually adding');
});

/* ── 2. cleanup covers every business the tick touched ──────────────────── */

test('the run-id sweep is not scoped to one fixture business', () => {
  const text = src(CYCLE);
  const decl = text.slice(text.indexOf('const runIdsSince'), text.indexOf('const runIdsSince') + 400);
  assert.doesNotMatch(decl, /FIXTURE_TENANT/,
    'runIdsSince is scoped to one tenant again — the second business on the agent leaks run rows');
  assert.match(decl, /triggered_at >= @s/,
    'runIdsSince must still bound itself to this run');
});

test('a voice the tick learned is removed with everything else', () => {
  const text = src(CYCLE);
  assert.match(text, /DELETE FROM arion\.content_agent_tenant_style WHERE created_at >= @s/,
    'the cleanup must remove any style profile written during the run — otherwise the routes '
    + 'verifier reports a learned voice nobody taught it');
});

/* ── 3. nothing measures itself against a number typed in ───────────────── */

test('the cycle verifier measures cleanup against a snapshot, not a typed-in count', () => {
  const text = src(CYCLE);
  assert.doesNotMatch(text, /const original = \{ runs: 4, outputs: 3 \}/,
    'the pre-existing fixture counts are hard-coded again');
  assert.match(text, /const baseline = await wholeCounts\(pool\)/,
    'the cycle verifier must snapshot the counts before it writes anything');
  assert.match(text, /gone\.styles === baseline\.styles/,
    'the learned voices must be counted back too');
});

test('the routes verifier measures cleanup against a snapshot, not a typed-in count', () => {
  const text = src(ROUTES);
  assert.doesNotMatch(text, /counts\.runs === 4 && counts\.outputs === 3 && counts\.signals === 2/,
    'the routes verifier hard-codes the fixture counts again');
  assert.match(text, /const baseline = \(await pool\.request\(\)\.query\(/,
    'the routes verifier must snapshot the counts before it writes anything');
  assert.match(text, /counts\.runs === baseline\.runs/,
    'the routes verifier must compare against its own snapshot');
});

/* ── 4. the assertions that described a defect now fixed ────────────────── */

test('the pricing check asserts LUMEN 174 has landed rather than that it has not', () => {
  const text = src(CYCLE);
  assert.doesNotMatch(text, /DEFECT CONFIRMED: none of them is in argus\.action_pricing/,
    'the script still reports the pricing defect as present — LUMEN 174 fixed it on 2026-09-08');
  assert.match(text, /inConsolidated\.length === 3/,
    'the script must now assert all three prices ARE in the consolidated home');
});

test('a completed run must carry a flag ARRAY, which is no longer always empty', () => {
  const text = src(CYCLE);
  assert.doesNotMatch(text, /decision_rule_flags_json === '\[\]'/,
    'the flags check demands an EMPTY list again — ARGUS pack 1 made the decision rules '
    + 'actually run, so a clean draft can carry a note');
  assert.match(text, /Array\.isArray\(flagsParsed\)/,
    'the flags check must still refuse null: "no flags" and "never evaluated" are different answers');
});
