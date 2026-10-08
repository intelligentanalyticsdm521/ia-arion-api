// test/plain-words-credit-prices.test.mjs — the credit price descriptions an
// owner reads (Settings -> ARGUS data plan prints each action's description)
// never name a model, a model's size class or "Agent" (fixer pass, 2026-10-08).
//
// 071 seeds the arion.review_reply price row and was worded "(Haiku class)";
// it is not on production yet, so its wording is fixed in place. 072 rewrites
// the descriptions already in both pricing homes, one guarded UPDATE per
// action type. Each test goes red when its fix is taken out.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const MODEL_WORDS = /claude|sonnet|haiku|gpt|\bclass\b|agent/i;
/** The N'...' string literals a statement writes (comments stripped). */
const literals = (sqlText) => [...sqlText.replace(/--.*$/gm, '').matchAll(/N'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

test('071 seeds the review reply price in plain words, in both homes', () => {
  const text = read('071_review_reply_posting_and_held_reasons.sql');
  const seeded = literals(text).filter((l) => /Google review/.test(l));
  assert.equal(seeded.length, 2, 'one description per pricing home');
  for (const d of seeded) assert.doesNotMatch(d, MODEL_WORDS, d);
});

test('072 rewrites every description that names a model, in both homes, guarded and plain', () => {
  const text = read('072_plain_words_for_credit_prices.sql');
  const code = text.replace(/--.*$/gm, '');
  for (const home of ['argus.action_pricing', 'lumen.argus_action_pricing']) {
    assert.match(code, new RegExp(`IF OBJECT_ID\\('${home.replace('.', '\\.')}','U'\\) IS NOT NULL`), `${home} is not guarded`);
  }
  const updates = [...code.matchAll(/UPDATE (\S+) SET description = N'((?:[^']|'')*)'[^;]*WHERE action_type = N'([^']+)' AND \(([^;]+)\);/g)];
  const byHome = (h) => updates.filter((u) => u[1] === h).map((u) => u[3]);
  assert.deepEqual(byHome('argus.action_pricing'), byHome('lumen.argus_action_pricing'), 'the two homes get the same rows');
  // The 18 rows read from dev on 2026-10-08, the review reply row among them.
  assert.equal(byHome('argus.action_pricing').length, 18);
  assert.ok(byHome('argus.action_pricing').includes('arion.review_reply'));
  assert.equal(new Set(byHome('argus.action_pricing')).size, 18, 'one UPDATE per action type');
  for (const u of updates) {
    const words = u[2].replace(/''/g, "'");
    assert.doesNotMatch(words, MODEL_WORDS, `${u[3]}: ${words}`);
    assert.doesNotMatch(words, /\$/, `${u[3]} carries a dollar figure`);
    // Guarded: only while it still names a model, so a second run changes nothing.
    for (const w of ['Claude', 'Sonnet', 'Haiku', 'GPT', 'class']) assert.ok(u[4].includes(`description LIKE N'%${w}%'`), `${u[3]} is not guarded on ${w}`);
  }
});
