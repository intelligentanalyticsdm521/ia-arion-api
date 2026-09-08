// test/content-agent-style-isolation.test.js
//
// Scope 12.12 — per-tenant style learning, and the isolation that makes it safe.
//
// Brandon's constraint was "only the tenant they are currently assigned to".
// A client's voice is their commercial property; blending it into another
// client's content is a breach, not a bug. So isolation is tested at every
// layer that claims to enforce it:
//
//   argument  — assertTenantScope refuses a missing/malformed tenant id
//   query     — every statement carries tenant_id in its WHERE clause
//   result    — a foreign row that somehow came back is REFUSED, not used
//   schema    — covered separately in content-agent-schema.test.js, which
//               proves the filtered unique index actually rejects a second
//               active profile at the database
//
// The learning logic is deterministic on purpose (no model call), which is what
// makes it testable at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTenantScope, loadActiveProfile, recordSignal, unconsumedSignals,
  measureStyle, confidenceFor, buildProfile, renderStyleContext,
  levenshteinBudgeted, SIGNAL_KIND, MIN_EVIDENCE_FOR_CONFIDENCE,
} from '../lib/contentAgent/styleProfile.js';

const TENANT_A = 'a0000001-0000-0000-0000-000000000001';
const TENANT_B = 'b0000002-0000-0000-0000-000000000002';

function fakePool(rows = []) {
  return {
    queries: [],
    request() {
      const self = this;
      return {
        inputs: {},
        input(n, _t, v) { this.inputs[n] = v; return this; },
        async query(text) {
          self.queries.push({ text, inputs: this.inputs });
          return { recordset: rows };
        },
      };
    },
  };
}

// --- layer 1: the argument guard -------------------------------------------

test('assertTenantScope fails CLOSED on a missing or malformed tenant id', () => {
  for (const bad of [null, undefined, '', 'not-a-guid', 42, {}]) {
    assert.throws(() => assertTenantScope(bad), /valid tenant scope/i,
      `must refuse ${JSON.stringify(bad)} rather than build an unscoped query`);
  }
  assert.equal(assertTenantScope(TENANT_A), TENANT_A);
});

test('every entry point refuses to run unscoped', async () => {
  const pool = fakePool();
  await assert.rejects(() => loadActiveProfile(pool, null), /valid tenant scope/i);
  await assert.rejects(() => unconsumedSignals(pool, ''), /valid tenant scope/i);
  await assert.rejects(
    () => recordSignal(pool, { tenantId: null, signalKind: SIGNAL_KIND.EDITED }),
    /valid tenant scope/i,
  );
  assert.equal(pool.queries.length, 0, 'no query may be issued without a tenant scope');
});

// --- layer 2: the query ----------------------------------------------------

test('the active-profile read is tenant-scoped in SQL', async () => {
  const pool = fakePool([]);
  await loadActiveProfile(pool, TENANT_A);
  const q = pool.queries[0];
  assert.match(q.text, /WHERE\s+tenant_id\s*=\s*@tenantId/i, 'tenant filter belongs in the WHERE clause');
  assert.match(q.text, /is_active\s*=\s*1/i);
  assert.equal(q.inputs.tenantId, TENANT_A);
});

test('signal reads and writes are tenant-scoped in SQL', async () => {
  const pool = fakePool([]);
  await unconsumedSignals(pool, TENANT_A);
  assert.match(pool.queries[0].text, /tenant_id\s*=\s*@tenantId/i);

  const pool2 = fakePool([]);
  await recordSignal(pool2, {
    tenantId: TENANT_B, outputId: null, signalKind: SIGNAL_KIND.EDITED,
    beforeText: 'a', afterText: 'b',
  });
  assert.equal(pool2.queries[0].inputs.tenantId, TENANT_B);
});

test('an unknown signal kind is rejected before it reaches the database', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => recordSignal(pool, { tenantId: TENANT_A, signalKind: 'vibes' }),
    /unknown signal kind/i,
  );
  assert.equal(pool.queries.length, 0);
});

// --- layer 3: the result guard ---------------------------------------------

test('a profile belonging to another tenant is REFUSED, not used', async () => {
  // Simulates the nightmare: a query bug returns tenant B's row while drafting
  // for tenant A. Silently using it would write B's voice into A's content.
  const foreign = [{
    style_id: 's1', tenant_id: TENANT_B, site_id: null, profile_version: 3,
    voice_json: '{}', vocabulary_json: '{}', formatting_json: '{}',
    brand_tokens_json: '{}', authority_json: '{}', evidence_count: 40, confidence: 0.8,
  }];
  await assert.rejects(
    () => loadActiveProfile(fakePool(foreign), TENANT_A),
    /does not belong to the requested tenant/i,
    'drafting in the wrong client\'s voice must fail loudly, never silently',
  );
});

test('a tenant with no profile yet returns null, not an error and not a default', async () => {
  assert.equal(await loadActiveProfile(fakePool([]), TENANT_A), null);
});

// --- cold start -------------------------------------------------------------

test('a thin profile renders NO style context rather than inventing a voice', () => {
  const thin = buildProfile({ signals: [{ signal_kind: SIGNAL_KIND.APPROVED_AS_IS }], publishedTexts: [] });
  assert.ok(thin.evidenceCount < MIN_EVIDENCE_FOR_CONFIDENCE);
  assert.equal(renderStyleContext(thin), '',
    'inventing a voice from almost no evidence is worse than having none — cold start must fall back to the declared brand profile');
  assert.equal(renderStyleContext(null), '');
});

test('confidence rises with evidence and never reaches certainty', () => {
  assert.equal(confidenceFor(0), 0);
  assert.equal(confidenceFor(MIN_EVIDENCE_FOR_CONFIDENCE - 1), 0);
  assert.ok(confidenceFor(25) > confidenceFor(10));
  assert.ok(confidenceFor(10_000) < 1, 'a learned style is never certain');
});

// --- the measurable half ----------------------------------------------------

test('measureStyle counts habits rather than interpreting them', () => {
  const m = measureStyle([
    '# Heading\n\nShort one. Another short one.\n\n- a bullet\n- another\n\nWow!',
  ]);
  assert.equal(m.usesHeadings, true);
  assert.equal(m.usesBullets, true);
  assert.ok(m.exclamationsPer1k > 0);
  assert.ok(m.avgSentenceWords > 0);
  assert.equal(measureStyle([]), null, 'no samples means no measurement, not a fabricated one');
});

// --- learning ---------------------------------------------------------------

test('the heaviest edits become exemplars — a rewrite teaches more than a comma', () => {
  const signals = [
    { signal_kind: SIGNAL_KIND.EDITED, field_name: 'title', before_text: 'Unlock The Power Of Drains', after_text: 'What actually clogs a drain', edit_distance: 25 },
    { signal_kind: SIGNAL_KIND.EDITED, field_name: 'body', before_text: 'Hello world.', after_text: 'Hello world', edit_distance: 1 },
  ];
  const p = buildProfile({ signals, publishedTexts: ['Some published copy here.'] });
  assert.equal(p.voice.exemplars[0].field, 'title', 'the heavier edit must rank first');
  assert.equal(p.voice.exemplars.length, 2);
});

test('words edited out become banned vocabulary, and the list stays bounded', () => {
  const signals = [{
    signal_kind: SIGNAL_KIND.EDITED, field_name: 'body',
    before_text: 'We leverage synergy to revolutionize outcomes',
    after_text: 'We fix drains', edit_distance: 30,
  }];
  const p = buildProfile({ signals, publishedTexts: [] });
  assert.ok(p.vocabulary.banned.includes('leverage'));
  assert.ok(p.vocabulary.banned.includes('revolutionize'));
  assert.ok(p.vocabulary.banned.length <= 200, 'an unbounded ban list would eventually forbid the language');
});

test('versions increment and evidence accumulates across generations', () => {
  const v1 = buildProfile({ signals: [{ signal_kind: SIGNAL_KIND.APPROVED_AS_IS }], publishedTexts: [] });
  assert.equal(v1.version, 1);
  const v2 = buildProfile({ signals: [{ signal_kind: SIGNAL_KIND.APPROVED_AS_IS }], publishedTexts: [], previous: v1 });
  assert.equal(v2.version, 2);
  assert.equal(v2.evidenceCount, 2);
});

test('a mature profile renders context that names the habits it learned', () => {
  const signals = Array.from({ length: 30 }, (_, i) => ({
    signal_kind: SIGNAL_KIND.EDITED, field_name: 'body',
    before_text: `Draft revolutionize version ${i}`, after_text: `Published version ${i}`, edit_distance: 12,
  }));
  const p = buildProfile({ signals, publishedTexts: ['A published paragraph of reasonable length here. And another sentence.'] });
  const ctx = renderStyleContext(p);
  assert.match(ctx, /LEARNED STYLE FOR THIS CLIENT/);
  assert.match(ctx, /BEFORE:/, 'the edit pairs are the highest-signal few-shot material');
  assert.match(ctx, /AFTER:/);
  assert.match(ctx, /confidence/);
});

// --- utility ----------------------------------------------------------------

test('edit distance is budgeted so a pathological pair cannot burn the run', () => {
  assert.equal(levenshteinBudgeted('abc', 'abc'), 0);
  assert.equal(levenshteinBudgeted('abc', 'abd'), 1);
  const huge = 'x'.repeat(100_000);
  const t0 = Date.now();
  levenshteinBudgeted(huge, `${huge}y`);
  assert.ok(Date.now() - t0 < 5000, 'must stay bounded on pathological input');
});
