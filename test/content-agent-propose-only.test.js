// test/content-agent-propose-only.test.js
//
// Scope 12.13 — the agent may WRITE code proposals and may never APPLY one.
//
// Brandon asked whether the agent could "write some internal code as it learns
// from our intelligence layers if it can do it safely". The answer this build
// gives is: it writes a diff and a rationale into arion.content_agent_code_proposal
// and stops. There is no code path that reads diff_text and runs it, and adding
// one has to be a deliberate act rather than an oversight.
//
// "There is no such path" is exactly the kind of claim a comment cannot carry, so
// it is asserted here against the SOURCE. Three things are checked, and each one
// is the thing that would have to be true for the agent to escape the queue:
//
//   1. NOTHING IN THE AGENT CAN EXECUTE. No child_process, no exec/spawn, no
//      eval, no `new Function`, no vm, no dynamic import of a proposal's
//      contents, no git. A propose-only queue in a module that can shell out is
//      propose-only by convention, which is not a control.
//   2. THE API HAS NO APPLY DOOR. The review surface reads proposals and records
//      a human's verdict. `approve` means "a person may now take this through
//      the ordinary session process", and the response says so in words.
//   3. diff_text IS ONLY EVER READ. It appears in a SELECT list and nowhere
//      else — never as an argument, never written to a file, never interpolated
//      into a command.
//
// MUTATION-TESTED: adding `import { execSync } from 'node:child_process'` to any
// lib/contentAgent module, or a POST /proposals/:id/apply route, turns this file
// red. Both were tried on purpose before it was committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const AGENT_DIR = 'lib/contentAgent';
const ROUTE = 'routes/arion/contentAgent.js';

const agentFiles = fs.readdirSync(AGENT_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(AGENT_DIR, f));

const sources = [...agentFiles, ROUTE].map((f) => ({ file: f, src: fs.readFileSync(f, 'utf8') }));

/** Strip block and line comments so a comment ABOUT eval is not read as eval. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// The primitives that turn text into behaviour. Each is spelled as it would
// actually appear; a new spelling is a new line here, deliberately.
const EXECUTION_PRIMITIVES = [
  /require\(\s*['"]child_process['"]/,
  /from\s+['"](?:node:)?child_process['"]/,
  /import\(\s*['"](?:node:)?child_process['"]/,
  /\bexecSync\s*\(/,
  /\bexecFile(?:Sync)?\s*\(/,
  /\bspawn(?:Sync)?\s*\(/,
  /(?<![.\w])eval\s*\(/,
  /new\s+Function\s*\(/,
  /from\s+['"](?:node:)?vm['"]/,
  /\bvm\.runIn/,
  /\bsimple-git\b/,
  /\bnodegit\b/,
];

test('nothing in the agent can execute anything — no exec, spawn, eval, vm or git', () => {
  assert.ok(agentFiles.length >= 14, `expected the whole agent, found ${agentFiles.length} files`);
  for (const { file, src } of sources) {
    const stripped = code(src);
    for (const re of EXECUTION_PRIMITIVES) {
      assert.ok(
        !re.test(stripped),
        `${file} contains an execution primitive (${re}). The code-proposal queue is propose-only: `
        + 'a module that can run what it wrote is not a queue, it is a deploy.',
      );
    }
  }
});

test('the agent writes no file anywhere in the repo', () => {
  // The other way to "apply" a diff is to write it over a source file. The only
  // bytes this agent persists go to SQL or to the asset store (blob, and only
  // rendered PNGs under a tenant/output prefix).
  for (const { file, src } of sources) {
    const stripped = code(src);
    for (const re of [/\bfs\.write/, /\bwriteFile(?:Sync)?\s*\(/, /\bappendFile(?:Sync)?\s*\(/, /createWriteStream\s*\(/]) {
      assert.ok(!re.test(stripped), `${file} writes to the filesystem (${re}) — the agent may not touch source`);
    }
  }
});

test('diff_text is only ever SELECTed — never passed anywhere', async () => {
  const src = fs.readFileSync(ROUTE, 'utf8');
  const stripped = code(src);
  const mentions = [...stripped.matchAll(/diff_text/g)];
  assert.ok(mentions.length >= 1, 'the review surface has to be able to show the diff');
  // Every mention must sit inside a SELECT column list. Anything else — an
  // argument, a template literal, an assignment — is a use, not a read.
  for (const m of mentions) {
    const before = stripped.slice(Math.max(0, m.index - 400), m.index);
    assert.ok(
      /SELECT[\s\S]*$/i.test(before) && !/=\s*$/.test(before.trimEnd()),
      'diff_text appears outside a SELECT column list — it must never be used, only read',
    );
  }
});

test('the review surface has no apply/execute/deploy door', async () => {
  const router = (await import('../routes/arion/contentAgent.js')).default;
  const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`);
  for (const p of paths) {
    assert.ok(
      !/(apply|execute|run-proposal|deploy|commit|merge|patch)/i.test(p),
      `route "${p}" reads as a way to apply a proposal; there must not be one`,
    );
  }
  // And the one it does have is the human verdict, on the queue only.
  assert.ok(paths.includes('post /proposals/:id/:decision'), 'the human verdict endpoint is missing');
});

test('the decision endpoint accepts approve and reject and NOTHING else', () => {
  const src = code(fs.readFileSync(ROUTE, 'utf8'));
  assert.match(src, /\['approve', 'reject'\]\.includes\(decision\)/,
    'the decision vocabulary must be a closed list of two');
  assert.ok(!/'applied'\s*:/.test(src) || /applied: false/.test(src),
    'nothing in the response may claim a proposal was applied');
  assert.match(src, /applied: false/, 'the response has to say, in the payload, that nothing was applied');
  assert.match(src, /does NOT apply the change/i,
    'an approval message that does not say it applies nothing will be read as "done"');
});

test('applied_commit is never written by code — it is a human record', () => {
  for (const { file, src } of sources) {
    const stripped = code(src);
    assert.ok(
      !/SET[\s\S]{0,200}applied_commit\s*=/i.test(stripped),
      `${file} writes applied_commit. That column records what a PERSON did afterwards; `
      + 'code writing it would make the agent the author of its own approval.',
    );
  }
});

test('the proposal table is reachable only through SELECT and a status UPDATE', () => {
  const stripped = code(fs.readFileSync(ROUTE, 'utf8'));
  const stmts = [...stripped.matchAll(/(SELECT|INSERT INTO|UPDATE|DELETE FROM)([\s\S]{0,300}?)content_agent_code_proposal/gi)];
  assert.ok(stmts.length >= 2, 'expected the read and the verdict write');
  for (const s of stmts) {
    const verb = s[1].toUpperCase();
    assert.ok(verb === 'SELECT' || verb === 'UPDATE', `unexpected ${verb} against the proposal queue`);
  }
  // NOTE — there is no PRODUCER on this branch. The table, the review surface
  // and this guard exist; the step that generates a proposal from what the agent
  // learned (scope 12.13, Task 4's second half) was never written. That is
  // recorded as a gap rather than filled in silently, and this test is what an
  // eventual producer has to keep passing: write the row, and nothing else.
  assert.ok(
    !/INSERT INTO\s+arion\.content_agent_code_proposal/i.test(stripped),
    'if a producer arrives it belongs in lib/, not in the review route',
  );
});
