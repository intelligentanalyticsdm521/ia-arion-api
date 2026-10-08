// test/plain-words-credit-prices.test.mjs — the credit price descriptions an
// owner reads (Settings -> ARGUS data plan prints each action's description)
// never name a model, a model's size class or "Agent" (fixer pass, 2026-10-08).
//
// 071 seeds the arion.review_reply price row and was worded "(Haiku class)";
// it is not on production yet, so its wording is fixed in place. 072 rewrites
// the descriptions already in both pricing homes, one guarded UPDATE per
// action type. 073 does the same for the rows 072 did not list (empty rows, a
// person's name, an unpriced proposal, internal notes). Each test goes red
// when its fix is taken out.

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

// 073 (verifier 15:33Z): the rows 072 did not list still read as internal
// notes (a model name, a person's name, an unpriced proposal, "pattern match",
// "No model call") or were empty. The page no longer prints the action's key,
// so every active row's description is the only words an owner reads.
const NOT_PLAIN = /claude|sonnet|haiku|gpt|u2net|\bclass\b|agent|tenant|brandon|proposed|pattern match|model call|self-hosted|intelligence layer|platform cost|client|audited|metered|portal|\bIL\b|\bCTA\b|\bAI\b|\bmodel\b|\d+\s*-\s*\d+\s*cr\b/i;

test('073 gives every remaining price row plain words, in both homes, guarded, and prints what is left', () => {
  const text = read('073_plain_words_for_remaining_credit_prices.sql');
  const code = text.replace(/--.*$/gm, '');
  for (const home of ['argus.action_pricing', 'lumen.argus_action_pricing']) {
    assert.ok(code.includes(`IF OBJECT_ID('${home}','U') IS NOT NULL`), `${home} is not guarded`);
    // The pipeline log shows the count of rows still not in plain words (0).
    assert.ok(code.includes(`SELECT N'${home}' AS pricing_home, @left AS still_not_plain;`), `${home} does not print what is left`);
    assert.ok(code.includes(`FROM ${home} WHERE is_active = 1 AND (description IS NULL OR `), `${home} does not count empty descriptions`);
  }
  const updates = [...code.matchAll(/UPDATE (\S+) SET description = N'((?:[^']|'')*)'[^;]*WHERE action_type = N'([^']+)' AND \(([^;]+)\);/g)];
  const byHome = (h) => updates.filter((u) => u[1] === h).map((u) => u[3]);
  assert.deepEqual(byHome('argus.action_pricing'), byHome('lumen.argus_action_pricing'), 'the two homes get the same rows');
  // The 17 rows read from dev on 2026-10-08 that 072 did not reach.
  const expected = [
    'argus.reply_voice_rewrite', 'arion.site_assemble_page', 'copy_refresh', 'element_rewrite', 'il.chat_extract',
    'image_swap', 'my_brand.bg_remove', 'my_brand.image_generate', 'my_brand.image_generate_hd', 'oliver.insight_report',
    'page_add', 'site_initial_build', 'spark.email_body_generate', 'spark.improve_copy', 'spark.subject_ab_autopilot',
    'spark.subject_lines', 'variant_explore',
  ];
  assert.deepEqual([...byHome('argus.action_pricing')].sort(), [...expected].sort(), 'one UPDATE per remaining action type');
  for (const u of updates) {
    const words = u[2].replace(/''/g, "'");
    assert.doesNotMatch(words, MODEL_WORDS, `${u[3]}: ${words}`);
    assert.doesNotMatch(words, NOT_PLAIN, `${u[3]}: ${words}`);
    assert.doesNotMatch(words, /\$/, `${u[3]} carries a dollar figure`);
    assert.ok(!words.includes(u[3]), `${u[3]} prints its own key`);
    assert.match(words, /^[A-Z][^]*\.$/, `${u[3]} is not one sentence-shaped line`);
    // Guarded: only while empty, the old seeded text, or still internal words.
    assert.ok(u[4].startsWith('description IS NULL OR '), `${u[3]} does not fill an empty description`);
    for (const w of ['Claude', 'Haiku', 'u2net', 'Brandon', 'PROPOSED', 'pattern match', 'model call', 'self-hosted']) {
      assert.ok(u[4].includes(`description LIKE N'%${w}%'`), `${u[3]} is not guarded on ${w}`);
    }
    assert.ok(u[4].includes(`COLLATE Latin1_General_CS_AS LIKE N'%IL %'`), `${u[3]} is not guarded on IL`);
  }
});
