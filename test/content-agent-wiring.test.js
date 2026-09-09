// test/content-agent-wiring.test.js
//
// The take-over checks: this feature was built in a working copy and landed on
// release/sept-a-2026 afterwards, and every one of the things that goes wrong in
// that move is cheap to pin and expensive to find later.
//
//   THE MOUNT        A router nobody mounts is 404 on every path, and the tests
//                    for its handlers all still pass. Both mounts are asserted.
//   THE NUMBER       053 and 054 belong to 053_site_tier_hygiene.sql and
//                    054_site_internal_ip_list.sql on this line. The agent's two
//                    migrations are 063/064, reserved in the work registry, and
//                    the old numbers must not reappear.
//   THE IDEMPOTENCE  Every object is guarded individually, so a table that
//                    exists with a missing index still converges.
//   THE MODEL        claude-opus-5 is not in PROVIDER_COSTS. A model with no
//                    price records a null cost basis, which switches off
//                    outlier-refund protection silently — so the configured
//                    models must be ones the wrapper can price, and nobody may
//                    "upgrade" the agent by editing a string.
//   THE PUBLISHER    Task 7's module existed and nothing called it. Now one
//                    route does, and it is the only door to WordPress.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MODELS } from '../lib/contentAgent/config.js';
import { PROVIDER_COSTS } from '../lib/argus/callWrapper.js';

const MIGRATIONS = 'db/migrations';
const AGENT_MIGRATIONS = ['063_content_agent.sql', '064_content_agent_tenant_config.sql'];

test('the content-agent router is mounted under /arion', () => {
  const src = fs.readFileSync('routes/arion.js', 'utf8');
  assert.match(src, /import contentAgentRouter from '\.\/arion\/contentAgent\.js'/);
  assert.match(src, /router\.use\('\/content-agent', contentAgentRouter\)/,
    'without this line every content-agent endpoint is a 404 and every handler test still passes');
});

test('the review surface is the shape the scope names, plus the publish door', async () => {
  const router = (await import('../routes/arion/contentAgent.js')).default;
  const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  for (const expected of [
    'get /queue', 'post /queue/:id/approve', 'post /queue/:id/reject',
    'post /queue/:id/publish', 'get /runs', 'get /style',
    'get /proposals', 'post /proposals/:id/:decision',
  ]) {
    assert.ok(paths.includes(expected), `missing route: ${expected} (have: ${paths.join(', ')})`);
  }
});

test('publishing is a SECOND human action, wired to the publisher that refuses unapproved work', () => {
  const src = fs.readFileSync('routes/arion/contentAgent.js', 'utf8');
  assert.match(src, /import \{ publishApproved, PublishRefused \}/,
    'the publish route must use the module whose tests hold the AC8 gate');
  // The gate itself stays in lib/contentAgent/publisher.js — the route must not
  // grow a second copy of the approval check.
  assert.ok(!/review_status IN \('approved','edited'\)/.test(src),
    'the approval gate belongs in the publisher, not duplicated in the route');
  assert.match(src, /published: false/, 'a failed publish must say so in the payload');
});

test('the two migrations are 063 and 064 and the old numbers are gone', () => {
  const files = fs.readdirSync(MIGRATIONS);
  for (const f of AGENT_MIGRATIONS) {
    assert.ok(files.includes(f), `missing migration ${f}`);
  }
  assert.ok(!files.includes('053_content_agent.sql'), '053 is 053_site_tier_hygiene.sql on this line');
  assert.ok(!files.includes('054_content_agent_tenant_config.sql'), '054 is 054_site_internal_ip_list.sql on this line');
  // and nothing on the line was displaced
  assert.ok(files.includes('053_site_tier_hygiene.sql'));
  assert.ok(files.includes('054_site_internal_ip_list.sql'));
  // no duplicate numbers anywhere in the folder
  const byNumber = new Map();
  for (const f of files.filter((x) => /^\d{3}_.*\.sql$/.test(x))) {
    const n = f.slice(0, 3);
    assert.ok(!byNumber.has(n), `two migrations share number ${n}: ${byNumber.get(n)} and ${f}`);
    byNumber.set(n, f);
  }
});

test('both migrations name their new number inside the file, not just in the filename', () => {
  for (const f of AGENT_MIGRATIONS) {
    const src = fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8');
    // .trim() because git checks these files out with CRLF on Windows, and the
    // trailing \r made this assertion fail in a FRESH worktree while passing in
    // the one the file was authored in. A test whose result depends on which
    // checkout it runs from is a test nobody can trust.
    assert.match(src.split('\n')[0].trim(), new RegExp(`^-- ${f}$`), `${f} header does not match its name`);
    assert.match(src, /RENUMBERED 05[34] -> 06[34]/, `${f} must carry the reason it was renumbered`);
  }
});

test('every table AND every index is guarded on its own — a half-created table converges', () => {
  for (const f of AGENT_MIGRATIONS) {
    const src = fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8');
    const creates = [...src.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1]);
    assert.ok(creates.length > 0, `${f} creates no indexes?`);
    for (const idx of creates) {
      assert.ok(
        src.includes(`WHERE name = '${idx}' AND object_id = OBJECT_ID(`),
        `${f}: index ${idx} is not guarded on sys.indexes. Inside the table's IF-NULL block it can `
        + 'never be created for a table that already exists — the file reports success and changes nothing.',
      );
    }
    for (const tbl of [...src.matchAll(/CREATE TABLE ([\w.]+)/g)].map((m) => m[1])) {
      assert.ok(src.includes(`IF OBJECT_ID('${tbl}', 'U') IS NULL`), `${f}: table ${tbl} is not guarded`);
    }
  }
});

test('the configured models are ones ARGUS can price — and opus-5 is not one of them', () => {
  for (const [role, model] of Object.entries(MODELS)) {
    assert.ok(PROVIDER_COSTS[model], `${role} model "${model}" is absent from PROVIDER_COSTS: a null cost basis `
      + 'turns off the outlier-refund guard for every call it makes');
  }
  // Named explicitly because it is the model somebody will reach for next. It is
  // absent from the price table, so switching to it would silently disable the
  // per-call cost cap. Adding it here is not the fix — pricing it in BOTH
  // callWrappers is, and then this line changes deliberately.
  assert.equal(PROVIDER_COSTS['claude-opus-5'], undefined,
    'if opus-5 has been priced, revisit MODELS on purpose rather than by accident');
  assert.equal(MODELS.DRAFT, 'claude-sonnet-5');
  assert.equal(MODELS.SCAN, 'claude-haiku-4-5');
});

test('the agent never calls a provider except through the metering wrapper', () => {
  // meterAndAudit checks the balance, applies the per-call outlier cap, writes
  // the audit row and debits. A raw fetch to api.anthropic.com bypasses all four
  // and leaves the run log lying about what a cycle cost.
  const draft = fs.readFileSync('lib/contentAgent/drafting.js', 'utf8');
  assert.match(draft, /import \{ meterAndAudit \}/);
  assert.match(draft, /spendGuarded\(breaker, \(\) => meterAndAudit\(/,
    'every model call goes through the run cost breaker AND the meter');
  for (const f of fs.readdirSync('lib/contentAgent').filter((x) => x.endsWith('.js') && x !== 'drafting.js')) {
    const src = fs.readFileSync(`lib/contentAgent/${f}`, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/api\.anthropic\.com/.test(src), `${f} talks to Anthropic directly, outside the meter`);
  }
});

test('cost is stored as DECIMAL(10,6) dollars in the migration and in the writer', () => {
  const src = fs.readFileSync(`${MIGRATIONS}/063_content_agent.sql`, 'utf8');
  assert.match(src, /cost_usd\s+DECIMAL\(10,6\)/, 'integer cents rounds every row before the aggregate AC7 measures');
  // the header explains the cost_cents -> cost_usd deviation, so only the DDL is scanned
  const ddl = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('|');
  assert.ok(!/cost_cents/.test(ddl), 'no column may be integer cents');
  const runner = fs.readFileSync('lib/contentAgent/runner.js', 'utf8');
  assert.match(runner, /sql\.Decimal\(10, 6\)/, 'the writer has to agree with the column');
});
