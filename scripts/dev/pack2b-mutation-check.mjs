#!/usr/bin/env node
/**
 * pack2b-mutation-check.mjs — break every ARION pack 2b guard on purpose and
 * prove the thing that is supposed to catch it goes RED.
 *
 * A green check proves nothing until you have made it fail
 * (memory: feedback_mutation_test_your_guards). Each mutation below edits ONE
 * line of one file, runs the check that owns that guard, requires it to FAIL,
 * then puts the file back and proves it is byte-identical to what it was.
 *
 * Everything here is pure code — no site, no database, no container — so it is
 * safe to run at any time and it changes nothing but the files it puts back.
 *
 *   node scripts/dev/pack2b-mutation-check.mjs
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ARION = 'C:/dev/iadm/arion-api-septa-arion2b';
const PORTAL = 'C:/dev/iadm/Portal-septa-arion2b';

const SCHEMA = `${ARION}/lib/websiteBuilder/sectionSchema.js`;
const ADAPTER = `${ARION}/lib/websiteBuilder/libraryAdapter.js`;
const CATALOG = `${ARION}/lib/websiteBuilder/libraryCatalog.js`;
const SHEET = `${PORTAL}/src/arion/components/SectionEditSheet.tsx`;
const PAGES = `${PORTAL}/src/arion/pages/website/WebsitePages.tsx`;

let caught = 0;
let missed = 0;

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Run a command; true when it SUCCEEDED. */
function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

const checkers = {
  /** The pack's own unit tests. */
  pack2b: () => run(process.execPath, ['--test', 'test/arion-pack2b.test.mjs'], ARION),
  /** The coverage guard: "74 of 120", per archetype, and every one savable. */
  coverage: () => run(process.execPath, ['--test', 'test/site-builder-library-adapter.test.mjs'], ARION),
  /** The Portal's own rules about the sheet. */
  portal: () => run(
    process.execPath,
    ['--import', './scripts/test-ts-loader.mjs', '--test', 'test/arion-pack2b-ui.test.mjs'],
    PORTAL,
  ),
};

function mutate(m) {
  const before = fs.readFileSync(m.file, 'utf8');
  const beforeSha = sha(m.file);
  const count = before.split(m.from).length - 1;
  if (count !== 1) {
    console.log(`  SKIP    ${m.name} — the line to break was found ${count} times`);
    missed += 1;
    return;
  }
  fs.writeFileSync(m.file, before.replace(m.from, m.to));
  let stillGreen;
  try {
    stillGreen = checkers[m.checker]();
  } finally {
    fs.writeFileSync(m.file, before);
  }
  const restored = sha(m.file) === beforeSha;
  if (stillGreen) {
    missed += 1;
    console.log(`  MISSED  ${m.name} — the guard was broken and everything still passed`);
  } else {
    caught += 1;
    console.log(`  caught  ${m.name}`);
  }
  if (!restored) {
    missed += 1;
    console.log(`  ⚠ NOT RESTORED: ${m.file}`);
  }
}

console.log('\n=== finding the cards ===\n');

mutate({
  name: 'one container is not a list (two or more, or it is not a list)',
  file: ADAPTER, checker: 'pack2b',
  from: '    if (kids.length >= 2) {',
  to: '    if (kids.length >= 1) {',
});

mutate({
  name: 'the fingerprint is ORDERED, so a stat beside a quote is not two of a kind',
  file: ADAPTER, checker: 'pack2b',
  from: "  return widgetsUnder(node).map((w) => String(w.widgetType)).join(',');",
  to: "  return widgetsUnder(node).map((w) => String(w.widgetType)).sort().join(',');",
});

mutate({
  name: 'the biggest group wins, so an intro block does not steal the list',
  file: ADAPTER, checker: 'pack2b',
  from: '          || candidate.items.length > best.items.length',
  to: '          || candidate.items.length < best.items.length',
});

mutate({
  name: 'the cards are claimed BEFORE the headline step can eat one of their headings',
  file: ADAPTER, checker: 'coverage',
  from: '      result.claimed.forEach((w) => claimed.add(w));',
  to: '      result.claimed.forEach(() => {});',
});

console.log('\n=== the role rules, and saying when they guessed ===\n');

mutate({
  name: 'a currency sign or a digit is what makes a heading the price',
  file: ADAPTER, checker: 'pack2b',
  from: 'const PRICEY_RE = /[$€£¥₹]|\\d/;',
  to: 'const PRICEY_RE = /(?!)/;',
});

mutate({
  name: 'a bullet or a line break is what makes a block the "what is included" list',
  file: ADAPTER, checker: 'pack2b',
  from: 'const LISTY_RE = /<br\\s*\\/?>|<li[\\s>]|^\\s*(?:<p[^>]*>)?\\s*[✓✔•·\\-–—*]/i;',
  to: 'const LISTY_RE = /(?!)/;',
});

mutate({
  name: 'quotation marks are what make a block the quote',
  file: ADAPTER, checker: 'pack2b',
  from: 'const QUOTED_RE = /^\\s*(?:<p[^>]*>)?\\s*[“"\'‘«]/;',
  to: 'const QUOTED_RE = /(?!)/;',
});

mutate({
  name: 'a guess is WRITTEN DOWN (pricing name/price)',
  file: ADAPTER, checker: 'pack2b',
  from: "      if (guessed) { assign.set(headings[0], 'name'); assign.set(headings[1], 'price'); flag('name', 'price'); }",
  to: "      if (guessed) { assign.set(headings[0], 'name'); assign.set(headings[1], 'price'); }",
});

mutate({
  name: 'a guess is WRITTEN DOWN (pricing period/features)',
  file: ADAPTER, checker: 'pack2b',
  from: "      if (guessed) flag('period', 'features');",
  to: "      if (guessed) { /* nothing */ }",
});

mutate({
  name: 'a guess is WRITTEN DOWN (a quote with no quotation marks)',
  file: ADAPTER, checker: 'pack2b',
  from: "      if (guessed) flag('quote', 'role');",
  to: "      if (guessed) { /* nothing */ }",
});

mutate({
  name: 'the note reaches the section rather than dying in the adapter',
  file: ADAPTER, checker: 'pack2b',
  from: '  if (roleReview.length > 0) node.settings[ROLE_REVIEW_MARKER] = roleReview;',
  to: '  if (roleReview.length > 0) { /* nothing */ }',
});

mutate({
  name: 'the roles are decided once and applied by POSITION, so two cards cannot disagree',
  file: ADAPTER, checker: 'coverage',
  from: '      const widget = widgets[i];',
  to: '      const widget = widgets[widgets.length - 1 - i];',
});

console.log('\n=== what we refuse to touch ===\n');

mutate({
  name: 'markup we would rewrite is left unclaimed (a link inside a price line)',
  file: ADAPTER, checker: 'pack2b',
  from: '      if (!markupIsPlain(current, codecName)) return false;',
  to: '      if (false) return false;',
});

mutate({
  name: 'an unstamped button still fails the whole blueprint',
  file: ADAPTER, checker: 'pack2b',
  from: "const INTERACTIVE_WIDGETS = Object.freeze(new Set(['button', 'form']));",
  to: 'const INTERACTIVE_WIDGETS = Object.freeze(new Set([]));',
});

mutate({
  name: 'the pickability gate reads EVERY validation error, not just the empty ones',
  file: ADAPTER, checker: 'pack2b',
  from: '  const missing = check.errors.map((e) => e.message);',
  to: '  const missing = check.errors.filter((e) => /cannot be empty/.test(e.message)).map((e) => e.message);',
});

mutate({
  name: 'the vendor’s grey placeholder is blanked before it reaches a page',
  file: ADAPTER, checker: 'pack2b',
  from: '  clearPlaceholderImages(node);',
  to: '  // clearPlaceholderImages(node);',
});

mutate({
  name: 'a list is bound once — the old one-widget-per-item step stands down',
  file: ADAPTER, checker: 'pack2b',
  from: '    if (step.unless && claimedLists.has(step.unless)) continue;',
  to: '    if (false) continue;',
});

console.log('\n=== reading and writing one card ===\n');

mutate({
  name: 'a value the client did not change is not written back',
  file: SCHEMA, checker: 'pack2b',
  from: '    if (unchanged(currentRaw, item[fieldKey], (raw) => decodeValue(raw, spec))) continue;',
  to: '    if (false) continue;',
});

mutate({
  name: 'the number and what is around it are kept apart, so a "+" is not lost',
  file: SCHEMA, checker: 'pack2b',
  from: 'const STAT_NUMBER_RE = /^(\\D*?)(\\d[\\d.,]*\\d|\\d)([\\s\\S]*)$/;',
  to: 'const STAT_NUMBER_RE = /^()(.*)()$/;',
});

mutate({
  name: 'a "what is included" list keeps its line breaks',
  file: SCHEMA, checker: 'pack2b',
  from: "      return `<p>${lines.join('<br>')}</p>`;",
  to: '      return `<p>${lines.join(\' \')}</p>`;',
});

mutate({
  name: 'a surplus card is removed, whole',
  file: SCHEMA, checker: 'pack2b',
  from: '        if (i >= items.length) { plan.removals.add(entry.node); return; }',
  to: '        if (i >= items.length) { return; }',
});

mutate({
  name: 'an extra card is cloned from the last one, so it has the same design',
  file: SCHEMA, checker: 'pack2b',
  from: '      if (items.length > entries.length && entries.length > 0) {',
  to: '      if (false) {',
});

mutate({
  name: 'a card the layout has no room for is not offered as a box',
  file: SCHEMA, checker: 'pack2b',
  from: '      const present = roleSpec.on === \'container\' ? true : roles.has(roleKey);',
  to: '      const present = true;',
});

console.log('\n=== "check this", and the one tap ===\n');

mutate({
  name: 'a swap moves the role on EVERY card',
  file: SCHEMA, checker: 'pack2b',
  from: '    if (entry.marker !== bindingId) continue;',
  to: '    if (entry.marker !== bindingId || swapped >= 1) continue;',
});

mutate({
  name: 'two roles that are not the same kind of widget cannot be swapped',
  file: SCHEMA, checker: 'pack2b',
  from: '    if (binding.roles[roleA].widget !== binding.roles[roleB].widget) continue;',
  to: '    if (false) continue;',
});

mutate({
  name: 'answering a "check this" clears that one and leaves the others',
  file: SCHEMA, checker: 'pack2b',
  from: "    .filter((r) => [String(r?.roles?.[0]), String(r?.roles?.[1])].sort().join('|') !== wanted);",
  to: '    .filter(() => true);',
});

console.log('\n=== the one price source ===\n');

mutate({
  name: 'a curated price layout is filled from the business’s own catalogue',
  file: CATALOG, checker: 'pack2b',
  from: "  const node = mapped.kind === 'pricing'",
  to: "  const node = mapped.kind === 'never'",
});

mutate({
  name: 'we never grow a layout past the cards its author drew',
  file: CATALOG, checker: 'pack2b',
  from: '  return applyFields(node, \'pricing\', { plans: plans.slice(0, Math.max(1, drawn)) });',
  to: "  return applyFields(node, 'pricing', { plans });",
});

mutate({
  name: 'a business with no price list gets prompts, not the library’s sample prices',
  file: CATALOG, checker: 'pack2b',
  from: '  if (plans.length === 0) return node;',
  to: '  if (plans.length >= 0) return node;',
});

console.log('\n=== the screen a client uses ===\n');

mutate({
  name: 'the sheet renders only the boxes this layout can keep',
  file: SHEET, checker: 'portal',
  from: '    return { ...spec, item: spec.item.filter((sub) => allowed.includes(sub.key)) };',
  to: '    return { ...spec, item: spec.item };',
});

mutate({
  name: 'a new card is seeded from the filtered spec',
  file: SHEET, checker: 'portal',
  from: 'onAdd={() => onListAdd(spec.key, blankItem(shown))}',
  to: 'onAdd={() => onListAdd(spec.key, blankItem(spec))}',
});

mutate({
  name: 'the guess is shown as the server’s own sentence, not a code',
  file: SHEET, checker: 'portal',
  from: '        {review.why}',
  to: '        {review.list}',
});

mutate({
  name: 'the swap goes to the server — the Portal never invents Elementor JSON',
  file: PAGES, checker: 'portal',
  from: '        node: row.node,',
  to: '        node: { _ia_role: 1 },',
});

mutate({
  name: 'a failed swap says so instead of finishing quietly',
  file: PAGES, checker: 'portal',
  from: "      setError(messageFrom(e, 'We could not swap those two over. Nothing was changed.'));",
  to: '      void e;',
});

console.log(`\n=== ${caught} caught, ${missed} missed ===\n`);
process.exit(missed === 0 ? 0 : 1);
